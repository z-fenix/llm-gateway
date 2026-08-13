use crate::db::models::{KbChunk, KnowledgeBase};
use crate::knowledge::embed::Embedder;
use crate::knowledge::index::VectorIndex;
use crate::proxy::state::AppState;
use serde::Serialize;
use std::collections::HashMap;

/// 检索返回的片段。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetrievedChunk {
    pub embedding_id: i64,
    pub content: String,
    pub symbol: Option<String>,
    pub filename: String,
    pub score: f64,
}

const RRF_K: f64 = 60.0;
const RETRIEVE_VECTOR_TOP_K: usize = 20;
const RETRIEVE_FTS_TOP_K: usize = 20;

/// 纯函数：对向量检索与全文检索结果做 RRF 融合，返回 embedding_id 列表。
///
/// 两路结果各自按列表中的名次 rank（从 1 开始）打分：
/// `score = Σ 1 / (60 + rank)`
/// 合并相同 embedding_id 的分数后按分降序取 top_n。
pub fn rrf_fuse(vector_hits: &[(u64, f32)], fts_hits: &[(i64, f64)], top_n: usize) -> Result<Vec<i64>, String> {
    Ok(rrf_fuse_scored(vector_hits, fts_hits, top_n)?
        .into_iter()
        .map(|(id, _)| id)
        .collect())
}

fn rrf_fuse_scored(
    vector_hits: &[(u64, f32)],
    fts_hits: &[(i64, f64)],
    top_n: usize,
) -> Result<Vec<(i64, f64)>, String> {
    let mut scores: HashMap<i64, f64> = HashMap::new();

    for (rank, (id, _)) in vector_hits.iter().enumerate() {
        let rank = rank + 1;
        let emb_id = i64::try_from(*id)
            .map_err(|_| format!("embedding_id {} out of i64 range", id))?;
        *scores.entry(emb_id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
    }

    for (rank, (id, _)) in fts_hits.iter().enumerate() {
        let rank = rank + 1;
        *scores.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
    }

    let mut scored: Vec<(i64, f64)> = scores.into_iter().collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    Ok(scored.into_iter().take(top_n).collect())
}

/// 对查询做混合检索：先分别走向量相似度与 FTS5 全文，再用 RRF 融合回表取片段。
pub async fn retrieve(
    state: &AppState,
    kb: &KnowledgeBase,
    query: &str,
    top_n: usize,
) -> Result<Vec<RetrievedChunk>, String> {
    let embedder = Embedder::from_kb(state, kb)?;
    let query_vec = embedder
        .embed(&[query.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "embedding returned empty vector".to_string())?;

    let dim = query_vec.len();
    let index_path = state.kb_index_dir.read().join(format!("{}.usearch", kb.id));
    let query_vec_for_search = query_vec.clone();

    let vector_task = tokio::task::spawn_blocking(move || {
        let index = VectorIndex::open_or_create(&index_path, dim)?;
        index.search(&query_vec_for_search, RETRIEVE_VECTOR_TOP_K)
    });
    let repo_for_fts = state.repo.clone();
    let kb_id_for_fts = kb.id.clone();
    let query_for_fts = query.to_string();
    let fts_task = tokio::task::spawn_blocking(move || {
        repo_for_fts.fts_search_chunks(&kb_id_for_fts, &query_for_fts, RETRIEVE_FTS_TOP_K)
    });

    let (vector_hits, fts_hits) = tokio::try_join!(
        async {
            vector_task
                .await
                .map_err(|e| format!("vector search task failed: {e}"))?
                .map_err(|e| format!("vector search failed: {e}"))
        },
        async {
            fts_task
                .await
                .map_err(|e| format!("fts search task failed: {e}"))?
                .map_err(|e| format!("fts search failed: {e}"))
        }
    )?;

    let scored = rrf_fuse_scored(&vector_hits, &fts_hits, top_n)?;
    if scored.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<i64> = scored.iter().map(|(id, _)| *id).collect();
    let chunks = state
        .repo
        .get_chunks_by_embedding_ids(&kb.id, &ids)
        .map_err(|e| format!("chunk lookup failed: {e}"))?;
    let docs = state
        .repo
        .list_documents(&kb.id)
        .map_err(|e| format!("document lookup failed: {e}"))?;

    let filename_by_doc_id: HashMap<String, String> =
        docs.into_iter().map(|d| (d.id, d.filename)).collect();
    let chunk_by_id: HashMap<i64, KbChunk> =
        chunks.into_iter().map(|c| (c.embedding_id, c)).collect();

    let mut out = Vec::with_capacity(scored.len());
    for (id, score) in scored {
        let chunk = chunk_by_id
            .get(&id)
            .ok_or_else(|| format!("kb chunk missing for embedding_id {}", id))?;
        let filename = filename_by_doc_id
            .get(&chunk.doc_id)
            .cloned()
            .unwrap_or_default();
        out.push(RetrievedChunk {
            embedding_id: id,
            content: chunk.content.clone(),
            symbol: chunk.symbol.clone(),
            filename,
            score,
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{Channel, KbChunk, KbDocument, KnowledgeBase};
    use crate::db::Db;
    use crate::proxy::state::AppState;
    use axum::{routing::post, Json, Router};
    use serde_json::Value;
    use std::fs;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    #[test]
    fn rrf_fuse_merges_and_dedups() {
        // vector: id1 rank1, id2 rank2, id3 rank3
        let vector_hits = vec![(1u64, 0.1f32), (2u64, 0.2f32), (3u64, 0.3f32)];
        // fts: id2 rank1, id4 rank2
        let fts_hits = vec![(2i64, 1.0f64), (4i64, 2.0f64)];

        let ids = rrf_fuse(&vector_hits, &fts_hits, 3).unwrap();

        // id2 两路都命中，分数最高应排第一；id1 次之；id3/id4 同分取 id 小者
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], 2);
        assert_eq!(ids[1], 1);
        // id3 与 id4 分别为 1/(60+3)=1/63 与 1/(60+2)=1/62，id4 分数更高
        assert_eq!(ids[2], 4);
    }

    #[test]
    fn rrf_fuse_empty_inputs() {
        assert!(rrf_fuse(&[], &[], 5).unwrap().is_empty());
        assert!(rrf_fuse(&[(1u64, 0.0f32)], &[], 5).unwrap().is_empty() == false);
        assert!(rrf_fuse(&[], &[(1i64, 0.0f64)], 5).unwrap().is_empty() == false);
    }

    #[test]
    fn rrf_fuse_top_n_caps() {
        let vector_hits = vec![(1u64, 0.0f32), (2u64, 0.0f32), (3u64, 0.0f32)];
        let fts_hits = vec![(4i64, 0.0f64), (5i64, 0.0f64)];
        assert_eq!(rrf_fuse(&vector_hits, &fts_hits, 2).unwrap().len(), 2);
    }

    fn channel(id: &str, base_url: &str) -> Channel {
        Channel {
            id: id.into(),
            name: "embed-channel".into(),
            provider_type: "openai".into(),
            base_url: base_url.into(),
            api_key: "sk-embed-test".into(),
            models: vec!["text-embedding-3-small".into()],
            priority: 0,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn kb(id: &str) -> KnowledgeBase {
        KnowledgeBase {
            id: id.into(),
            name: format!("kb-{id}"),
            description: None,
            embedding_channel_id: None,
            embedding_model: "text-embedding-3-small".into(),
            dim: 4,
            doc_count: 0,
            chunk_count: 0,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    async fn spawn_mock_embeddings(status: u16, body: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
        let hits = Arc::new(Mutex::new(Vec::new()));
        let hits_clone = hits.clone();
        let app = Router::new().route(
            "/v1/embeddings",
            post(move |Json(v): Json<Value>| async move {
                hits_clone.lock().unwrap().push(v);
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(body.clone()))
            }),
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{}", addr), hits)
    }

    fn kb_doc(id: &str, kb_id: &str, filename: &str) -> KbDocument {
        KbDocument {
            id: id.into(),
            kb_id: kb_id.into(),
            filename: filename.into(),
            file_type: "txt".into(),
            size_bytes: 100,
            chunk_count: 1,
            status: "indexed".into(),
            error: None,
            created_at: 1,
        }
    }

    fn kb_chunk(id: &str, doc_id: &str, kb_id: &str, content: &str, emb_id: i64) -> KbChunk {
        KbChunk {
            id: id.into(),
            doc_id: doc_id.into(),
            kb_id: kb_id.into(),
            seq: emb_id,
            symbol: None,
            content: content.into(),
            token_count: 10,
            embedding_id: emb_id,
        }
    }

    fn test_index_path(kb_id: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir()
            .join("llm-gateway")
            .join("kb")
            .join(format!("retrieve_test_{}.usearch", kb_id));
        let _ = fs::remove_file(&path);
        path
    }

    #[tokio::test]
    async fn retrieve_hits_vector_and_fts() {
        let (base_url, _) = spawn_mock_embeddings(
            200,
            serde_json::json!({
                "object": "list",
                "data": [{"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]}]
            }),
        )
        .await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&channel("ch1", &base_url)).unwrap();
        state.rag.write().default_embedding_channel = Some("ch1".into());

        let kb_id = "retrieve_kb";
        let mut test_kb = kb(kb_id);
        test_kb.embedding_channel_id = Some("ch1".into());
        state.repo.create_kb(&test_kb).unwrap();
        state.repo.insert_document(&kb_doc("d1", kb_id, "alpha.txt")).unwrap();
        state.repo.insert_document(&kb_doc("d2", kb_id, "beta.txt")).unwrap();

        // 建 4 个 chunk，内容与向量分别对应不同方向
        state
            .repo
            .insert_chunks(&[
                kb_chunk("c1", "d1", kb_id, "hello alpha keyword", 1),
                kb_chunk("c2", "d2", kb_id, "beta keyword world", 2),
                kb_chunk("c3", "d1", kb_id, "other content", 3),
                kb_chunk("c4", "d2", kb_id, "more other content", 4),
            ])
            .unwrap();

        // 构造索引：emb1=[1,0,0,0], emb2=[0,1,0,0], emb3=[0,0,1,0], emb4=[0,0,0,1]
        let index_path = test_index_path(kb_id);
        let index_dir = index_path.parent().unwrap();
        let _ = fs::create_dir_all(index_dir);
        let index = VectorIndex::create(&index_path, 4).unwrap();
        index.add(1, &[1.0, 0.0, 0.0, 0.0]).unwrap();
        index.add(2, &[0.0, 1.0, 0.0, 0.0]).unwrap();
        index.add(3, &[0.0, 0.0, 1.0, 0.0]).unwrap();
        index.add(4, &[0.0, 0.0, 0.0, 1.0]).unwrap();
        index.save().unwrap();

        // 把 state 的索引目录指向临时文件所在目录（文件名由 kb_id 决定）
        *state.kb_index_dir.write() = index_dir.to_path_buf();

        // query 既命中向量 emb1，也命中 FTS "alpha"
        let results = retrieve(&state, &test_kb, "alpha keyword", 3).await.unwrap();

        assert!(!results.is_empty(), "retrieve should return hits");
        // emb1 向量最相似 + FTS 含 alpha，应排第一
        assert_eq!(results[0].embedding_id, 1);
        assert_eq!(results[0].filename, "alpha.txt");
        assert_eq!(results[0].content, "hello alpha keyword");
        assert!(results[0].score > 0.0);
    }

    #[tokio::test]
    async fn retrieve_empty_when_no_index_and_no_fts() {
        let (base_url, _) = spawn_mock_embeddings(
            200,
            serde_json::json!({
                "object": "list",
                "data": [{"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]}]
            }),
        )
        .await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&channel("ch1", &base_url)).unwrap();
        state.rag.write().default_embedding_channel = Some("ch1".into());

        let kb_id = "empty_kb";
        let mut test_kb = kb(kb_id);
        test_kb.embedding_channel_id = Some("ch1".into());
        state.repo.create_kb(&test_kb).unwrap();
        state.repo.insert_document(&kb_doc("d1", kb_id, "a.txt")).unwrap();
        state
            .repo
            .insert_chunks(&[kb_chunk("c1", "d1", kb_id, "irrelevant", 1)])
            .unwrap();

        // 无向量索引，open_or_create 会新建空索引；FTS 也无匹配
        let results = retrieve(&state, &test_kb, "nonexistent", 3).await.unwrap();
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn retrieve_error_when_chunk_missing() {
        let (base_url, _) = spawn_mock_embeddings(
            200,
            serde_json::json!({
                "object": "list",
                "data": [{"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]}]
            }),
        )
        .await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&channel("ch1", &base_url)).unwrap();
        state.rag.write().default_embedding_channel = Some("ch1".into());

        let kb_id = "missing_chunk_kb";
        let mut test_kb = kb(kb_id);
        test_kb.embedding_channel_id = Some("ch1".into());
        state.repo.create_kb(&test_kb).unwrap();
        state.repo.insert_document(&kb_doc("d1", kb_id, "a.txt")).unwrap();
        // 索引中写入 emb_id=999，但 DB 中不存在对应 chunk
        state
            .repo
            .insert_chunks(&[kb_chunk("c1", "d1", kb_id, "real content", 1)])
            .unwrap();

        let index_dir = std::env::temp_dir()
            .join("llm-gateway")
            .join("kb")
            .join(format!("missing_chunk_test_{}", kb_id));
        let _ = fs::remove_dir_all(&index_dir);
        let _ = fs::create_dir_all(&index_dir);
        let index_path = index_dir.join(format!("{}.usearch", kb_id));
        let index = VectorIndex::create(&index_path, 4).unwrap();
        index.add(999, &[1.0, 0.0, 0.0, 0.0]).unwrap();
        index.save().unwrap();

        *state.kb_index_dir.write() = index_dir;

        let err = retrieve(&state, &test_kb, "real content", 3)
            .await
            .unwrap_err();
        assert!(err.contains("kb chunk missing for embedding_id 999"), "{err}");
    }
}
