//! 知识库文档异步摄取管线。
//!
//! 将上传文档从「读取暂存内容 → 分块 → embedding → 写库 + 写向量索引」异步落成
//! 可检索状态。摄取失败只影响该文档(标记 `failed`),绝不 panic、绝不影响网关。

use crate::db::models::KbChunk;
use crate::knowledge::chunk::{chunk_code, chunk_text, detect_file_type, Chunk, FileType};
use crate::knowledge::embed::Embedder;
use crate::knowledge::index::VectorIndex;
use crate::proxy::state::AppState;
use std::path::PathBuf;

const CHUNK_TARGET_TOKENS: i64 = 500;
const CHUNK_OVERLAP_TOKENS: i64 = 50;
const RAW_SUFFIX: &str = "raw";

/// 文档原始内容暂存路径:`<kb_index_dir>/<doc_id>.raw`。
fn raw_doc_path(state: &AppState, doc_id: &str) -> PathBuf {
    state
        .kb_index_dir
        .read()
        .join(format!("{}.{}", doc_id, RAW_SUFFIX))
}

/// 将解码后的原始字节暂存到磁盘,供异步摄取任务按 doc_id 读取。
///
/// Task 9 的 `KbDocument` 不含 content 字段,上传命令解码后调用此函数暂存内容,
/// 摄取任务完成后会删除该文件。
pub fn stage_content(state: &AppState, doc_id: &str, content: &[u8]) -> Result<(), String> {
    let dir = state.kb_index_dir.read().clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create kb index dir: {e}"))?;
    let path = dir.join(format!("{}.{}", doc_id, RAW_SUFFIX));
    std::fs::write(&path, content).map_err(|e| {
        format!(
            "failed to stage document content at {}: {e}",
            path.display()
        )
    })?;
    Ok(())
}

/// 读取并清理文档暂存内容。读取成功后尽力删除文件,失败仅记录。
fn read_content(state: &AppState, doc_id: &str) -> Result<Vec<u8>, String> {
    let path = raw_doc_path(state, doc_id);
    let content = std::fs::read(&path)
        .map_err(|e| format!("failed to read staged content at {}: {e}", path.display()))?;
    if let Err(e) = std::fs::remove_file(&path) {
        log::warn!("failed to remove staged content {}: {}", path.display(), e);
    }
    Ok(content)
}

/// 异步摄取入口:`读文档 → 分块 → embedding → 写向量索引 + 落库 → 更新状态`。
///
/// 使用 Tauri 全局异步运行时 spawn,可从同步命令线程安全调用;内部捕获所有错误,
/// 失败仅标记该文档 `failed` 并 `log::error!`,绝不 panic。
pub fn spawn_ingest(state: AppState, doc_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_ingest(&state, &doc_id).await {
            if let Err(db_err) = state
                .repo
                .update_document_status(&doc_id, "failed", Some(&e))
            {
                log::error!(
                    "kb ingest failed to mark document {} failed: {}",
                    doc_id,
                    db_err
                );
            }
            log::error!("kb ingest failed for document {}: {}", doc_id, e);
        }
    });
}

async fn run_ingest(state: &AppState, doc_id: &str) -> Result<(), String> {
    let doc = state
        .repo
        .get_document(doc_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("document not found: {doc_id}"))?;
    let kb_id = doc.kb_id.clone();
    let kb = state
        .repo
        .get_kb(&kb_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("knowledge base not found: {kb_id}"))?;

    let raw = read_content(state, doc_id)?;
    let text = String::from_utf8(raw).map_err(|e| format!("document is not valid UTF-8: {e}"))?;
    let chunks = chunk_by_type(&doc.filename, &text);

    if chunks.is_empty() {
        return finalize(state, &kb_id, doc_id, 0);
    }

    let embedder = Embedder::from_kb(state, &kb)?;
    let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
    let vecs = embedder.embed(&texts).await?;
    if vecs.len() != chunks.len() {
        return Err(format!(
            "embedding count mismatch: expected {}, got {}",
            chunks.len(),
            vecs.len()
        ));
    }

    let dim = vecs
        .first()
        .map(|v| v.len())
        .filter(|d| *d > 0)
        .ok_or_else(|| "embedding returned empty vector".to_string())?;

    let index_path = state.kb_index_dir.read().join(format!("{}.usearch", kb_id));
    if let Some(parent) = index_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create kb index dir: {e}"))?;
    }

    let index = VectorIndex::open_or_create(&index_path, dim)?;
    let mut db_chunks: Vec<KbChunk> = Vec::with_capacity(chunks.len());
    for (chunk, vec) in chunks.iter().zip(vecs.iter()) {
        let embedding_id = state.repo.next_embedding_id().map_err(|e| e.to_string())?;
        index.add(embedding_id as u64, vec)?;
        db_chunks.push(KbChunk {
            id: uuid::Uuid::new_v4().to_string(),
            doc_id: doc_id.to_string(),
            kb_id: kb_id.clone(),
            seq: chunk.seq,
            symbol: chunk.symbol.clone(),
            content: chunk.content.clone(),
            token_count: chunk.token_count,
            embedding_id,
        });
    }

    state
        .repo
        .insert_chunks(&db_chunks)
        .map_err(|e| e.to_string())?;

    // 摄取尾段非原子:insert_chunks 已把 chunk 落库(含 FTS),此后 save/finalize 任一
    // 失败都必须回滚,否则「失败」文档的内容仍会被 FTS 检索命中,或在 save 成功后
    // 留下会破坏 retrieve 的孤儿向量 id。
    let tail = (|| -> Result<(), String> {
        index.save()?;
        finalize(state, &kb_id, doc_id, db_chunks.len() as i64)
    })();
    if let Err(e) = tail {
        rollback_chunks(state, doc_id, &index, &db_chunks);
        return Err(e);
    }
    Ok(())
}

/// 重建知识库向量索引:从 `kb_chunks.content` 重新 embedding,重写 usearch 索引并回写
/// 每个 chunk 的 embedding_id。失败返回 Err,由调用方记录错误(后台任务内 `log::error!`)。
pub async fn reindex_kb_contents(state: AppState, kb_id: String) -> Result<(), String> {
    let kb = state
        .repo
        .get_kb(&kb_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("knowledge base not found: {kb_id}"))?;

    let chunks = state.repo.list_chunks(&kb_id).map_err(|e| e.to_string())?;
    if chunks.is_empty() {
        return Ok(());
    }

    let embedder = Embedder::from_kb(&state, &kb)?;
    let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
    let vecs = embedder.embed(&texts).await?;
    if vecs.len() != chunks.len() {
        return Err(format!(
            "embedding count mismatch: expected {}, got {}",
            chunks.len(),
            vecs.len()
        ));
    }

    let dim = vecs
        .first()
        .map(|v| v.len())
        .filter(|d| *d > 0)
        .ok_or_else(|| "embedding returned empty vector".to_string())?;

    let index_path = state.kb_index_dir.read().join(format!("{}.usearch", kb_id));
    if let Some(parent) = index_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create kb index dir: {e}"))?;
    }
    // 先移除可能残留的旧索引文件:重建失败时不留与旧 embedding_id 不匹配的索引,
    // 使库保持「索引缺失 → needs_reindex」的可恢复状态。
    match std::fs::remove_file(&index_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "failed to remove kb index file {}: {}",
                index_path.display(),
                e
            ));
        }
    }

    // 新建空索引覆盖,add 完成后 save 落盘。
    let index = VectorIndex::create(&index_path, dim)?;
    for (chunk, vec) in chunks.iter().zip(vecs.iter()) {
        let embedding_id = state.repo.next_embedding_id().map_err(|e| e.to_string())?;
        index.add(embedding_id as u64, vec)?;
        state
            .repo
            .update_chunk_embedding_id(&chunk.id, embedding_id)
            .map_err(|e| e.to_string())?;
    }
    index.save()?;
    state
        .repo
        .mark_kb_reindexed(&kb_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 摄取尾段失败后的回滚:删除刚插入的 chunk(触发器同步清理 FTS),并从向量索引
/// 移除这些 embedding_id 后再次保存,保证「失败」文档不留任何可检索内容或孤儿向量。
fn rollback_chunks(state: &AppState, doc_id: &str, index: &VectorIndex, chunks: &[KbChunk]) {
    if let Err(e) = state.repo.delete_chunks_by_doc(doc_id) {
        log::error!(
            "kb ingest rollback: failed to delete chunks for document {}: {}",
            doc_id,
            e
        );
    }
    for chunk in chunks {
        // remove 在 id 不存在时返回 Err,这里忽略:目标只是确保最终索引里不存在这些 id。
        let _ = index.remove(chunk.embedding_id as u64);
    }
    if let Err(e) = index.save() {
        log::error!(
            "kb ingest rollback: failed to save index after removing vectors for document {}: {}",
            doc_id,
            e
        );
    }
}

fn chunk_by_type(filename: &str, text: &str) -> Vec<Chunk> {
    match detect_file_type(filename) {
        FileType::Markdown | FileType::Text => {
            chunk_text(text, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS)
        }
        FileType::Code => chunk_code(text, filename, CHUNK_TARGET_TOKENS),
    }
}

/// 成功路径收尾:重算知识库计数并标记文档 `indexed` 及其 chunk_count。
fn finalize(state: &AppState, kb_id: &str, doc_id: &str, chunk_count: i64) -> Result<(), String> {
    let doc_count = state
        .repo
        .list_documents(kb_id)
        .map_err(|e| e.to_string())?
        .len() as i64;
    let total_chunks = state
        .repo
        .list_chunks(kb_id)
        .map_err(|e| e.to_string())?
        .len() as i64;
    state
        .repo
        .update_kb_counts(kb_id, doc_count, total_chunks)
        .map_err(|e| e.to_string())?;
    state
        .repo
        .mark_document_indexed(doc_id, chunk_count)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{Channel, KbDocument, KnowledgeBase};
    use crate::db::Db;
    use crate::knowledge::retrieve::retrieve;
    use axum::{routing::post, Json, Router};
    use serde_json::Value;
    use std::net::SocketAddr;
    use std::time::Duration;

    fn channel(id: &str, base_url: &str) -> Channel {
        Channel {
            id: id.into(),
            name: "embed-channel".into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
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

    fn kb(id: &str, channel_id: Option<&str>) -> KnowledgeBase {
        KnowledgeBase {
            id: id.into(),
            name: format!("kb-{id}"),
            description: None,
            embedding_channel_id: channel_id.map(str::to_string),
            embedding_model: "text-embedding-3-small".into(),
            dim: 4,
            doc_count: 0,
            chunk_count: 0,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            needs_reindex: false,
        }
    }

    fn doc(id: &str, kb_id: &str, filename: &str) -> KbDocument {
        KbDocument {
            id: id.into(),
            kb_id: kb_id.into(),
            filename: filename.into(),
            file_type: "md".into(),
            size_bytes: 0,
            chunk_count: 0,
            status: "indexing".into(),
            error: None,
            created_at: 1,
        }
    }

    fn test_index_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("llm-gateway")
            .join("kb")
            .join(format!("ingest_{}_{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 200 时按 input 长度返回定维(4)向量;其余返回给定状态码与错误体。
    async fn spawn_mock(status: u16) -> String {
        let app = Router::new().route(
            "/v1/embeddings",
            post(move |Json(v): Json<Value>| async move {
                if status == 200 {
                    let input = v["input"].as_array().cloned().unwrap_or_default();
                    let data: Vec<Value> = input
                        .iter()
                        .enumerate()
                        .map(|(i, _)| {
                            serde_json::json!({
                                "object": "embedding",
                                "index": i,
                                "embedding": vec![i as f32; 4]
                            })
                        })
                        .collect();
                    (
                        axum::http::StatusCode::OK,
                        Json(serde_json::json!({ "object": "list", "data": data })),
                    )
                } else {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(serde_json::json!({ "error": "boom" })),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{}", addr)
    }

    async fn wait_for_status(state: &AppState, doc_id: &str, expected: &str) -> KbDocument {
        for _ in 0..200 {
            if let Some(d) = state.repo.get_document(doc_id).unwrap() {
                if d.status == expected {
                    return d;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "timed out waiting for document {} to become {}",
            doc_id, expected
        );
    }

    #[tokio::test]
    async fn ingest_indexes_document() {
        let base_url = spawn_mock(200).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        *state.kb_index_dir.write() = test_index_dir("indexes");

        state
            .repo
            .insert_channel(&channel("ch1", &base_url))
            .unwrap();
        let kb_id = "kb-ingest-ok".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-ingest-ok", &kb_id, "notes.md");
        state.repo.insert_document(&d).unwrap();
        stage_content(
            &state,
            &d.id,
            b"# Title\n\nquantum computing basics\n\n## Section\n\nentanglement explained",
        )
        .unwrap();

        spawn_ingest(state.clone(), d.id.clone());

        let indexed = wait_for_status(&state, &d.id, "indexed").await;
        assert!(
            indexed.chunk_count > 0,
            "document should have chunks: {}",
            indexed.chunk_count
        );
        assert_eq!(indexed.error, None);

        let chunks = state.repo.list_chunks(&kb_id).unwrap();
        assert!(!chunks.is_empty(), "chunks should be persisted");
        assert!(chunks.iter().all(|c| c.doc_id == d.id));

        let kb = state.repo.get_kb(&kb_id).unwrap().unwrap();
        assert_eq!(kb.doc_count, 1);
        assert_eq!(kb.chunk_count, chunks.len() as i64);

        let results = retrieve(&state, &kb, "quantum", 5).await.unwrap();
        assert!(!results.is_empty(), "ingested doc should be retrievable");
        assert!(results.iter().any(|r| r.filename == "notes.md"));
    }

    #[tokio::test]
    async fn ingest_marks_failed_on_embed_error() {
        let base_url = spawn_mock(500).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        *state.kb_index_dir.write() = test_index_dir("embed_error");

        let mut ch = channel("ch1", &base_url);
        ch.api_key = "sk-secret-key".into();
        state.repo.insert_channel(&ch).unwrap();
        let kb_id = "kb-ingest-err".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-ingest-err", &kb_id, "a.txt");
        state.repo.insert_document(&d).unwrap();
        stage_content(&state, &d.id, b"some content to embed").unwrap();

        spawn_ingest(state.clone(), d.id.clone());

        let failed = wait_for_status(&state, &d.id, "failed").await;
        let err = failed.error.expect("failed doc should carry an error");
        assert!(
            !err.contains("sk-secret-key"),
            "error must not leak api key: {err}"
        );
        assert!(
            state.repo.list_chunks(&kb_id).unwrap().is_empty(),
            "failed ingest should not persist chunks"
        );
    }

    #[tokio::test]
    async fn ingest_rolls_back_on_save_failure() {
        let base_url = spawn_mock(200).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let dir = test_index_dir("save_failure");
        *state.kb_index_dir.write() = dir.clone();

        state
            .repo
            .insert_channel(&channel("ch1", &base_url))
            .unwrap();
        let kb_id = "kb-ingest-savefail".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-ingest-savefail", &kb_id, "notes.md");
        state.repo.insert_document(&d).unwrap();
        stage_content(&state, &d.id, b"rollback secret keyword").unwrap();

        // 让索引保存路径成为目录,迫使 VectorIndex::save 失败
        std::fs::create_dir_all(dir.join(format!("{}.usearch", kb_id))).unwrap();

        spawn_ingest(state.clone(), d.id.clone());

        let failed = wait_for_status(&state, &d.id, "failed").await;
        assert!(failed.error.is_some(), "failed doc should carry an error");

        assert!(
            state.repo.list_chunks(&kb_id).unwrap().is_empty(),
            "save failure must roll back inserted chunks"
        );
        assert!(
            state
                .repo
                .fts_search_chunks(&kb_id, "rollback", 10)
                .unwrap()
                .is_empty(),
            "save failure must not leak chunks into FTS"
        );
    }

    #[tokio::test]
    async fn ingest_rollback_removes_chunks_and_vectors() {
        let base_url = spawn_mock(200).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let dir = test_index_dir("rollback_direct");
        *state.kb_index_dir.write() = dir.clone();

        state
            .repo
            .insert_channel(&channel("ch1", &base_url))
            .unwrap();
        let kb_id = "kb-ingest-rollback".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-ingest-rollback", &kb_id, "notes.md");
        state.repo.insert_document(&d).unwrap();

        // 模拟 save 成功、finalize 失败的状态:chunk 已落库、向量已写入并持久化索引
        let index_path = dir.join(format!("{}.usearch", kb_id));
        let index = VectorIndex::create(&index_path, 4).unwrap();
        let chunks: Vec<KbChunk> = (0..2)
            .map(|i| KbChunk {
                id: uuid::Uuid::new_v4().to_string(),
                doc_id: d.id.clone(),
                kb_id: kb_id.clone(),
                seq: i,
                symbol: None,
                content: format!("rollback secret keyword {i}"),
                token_count: 10,
                embedding_id: i + 1,
            })
            .collect();
        for c in &chunks {
            index
                .add(c.embedding_id as u64, &[1.0, 0.0, 0.0, 0.0])
                .unwrap();
        }
        state.repo.insert_chunks(&chunks).unwrap();
        index.save().unwrap();

        rollback_chunks(&state, &d.id, &index, &chunks);

        assert!(
            state.repo.list_chunks(&kb_id).unwrap().is_empty(),
            "rollback must delete inserted chunks"
        );
        assert!(
            state
                .repo
                .fts_search_chunks(&kb_id, "rollback", 10)
                .unwrap()
                .is_empty(),
            "rollback must sync chunks out of FTS"
        );

        // 回滚后重新打开索引,已移除的向量不应再被检索命中(无孤儿向量 id)
        let reopened = VectorIndex::open_or_create(&index_path, 4).unwrap();
        let hits = reopened.search(&[1.0, 0.0, 0.0, 0.0], 10).unwrap();
        assert!(
            hits.is_empty(),
            "rolled-back vectors must not remain in the saved index: {hits:?}"
        );
    }

    #[tokio::test]
    async fn reindex_rebuilds_index_and_updates_embedding_ids() {
        let base_url = spawn_mock(200).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let dir = test_index_dir("reindex");
        *state.kb_index_dir.write() = dir.clone();

        state
            .repo
            .insert_channel(&channel("ch1", &base_url))
            .unwrap();
        let kb_id = "kb-reindex".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-reindex", &kb_id, "notes.md");
        state.repo.insert_document(&d).unwrap();
        stage_content(&state, &d.id, b"# Title\n\nquantum computing basics").unwrap();
        spawn_ingest(state.clone(), d.id.clone());

        let indexed = wait_for_status(&state, &d.id, "indexed").await;
        assert!(indexed.chunk_count > 0, "doc should be ingested first");

        let before = state.repo.list_chunks(&kb_id).unwrap();
        assert!(!before.is_empty());
        let old_ids: Vec<i64> = before.iter().map(|c| c.embedding_id).collect();

        // 删除索引文件,模拟 usearch 索引缺失(对应 needs_reindex)。
        let index_path = dir.join(format!("{}.usearch", kb_id));
        std::fs::remove_file(&index_path).unwrap();
        assert!(!index_path.exists());

        reindex_kb_contents(state.clone(), kb_id.clone())
            .await
            .unwrap();

        // 索引文件已重建并落盘
        assert!(
            index_path.exists(),
            "reindex should persist a new index file"
        );

        // 每个 chunk 都分配了全新的 embedding_id
        let after = state.repo.list_chunks(&kb_id).unwrap();
        assert_eq!(after.len(), before.len());
        for c in &after {
            assert!(
                !old_ids.contains(&c.embedding_id),
                "chunk {} should have a fresh embedding_id, got {}",
                c.id,
                c.embedding_id
            );
        }

        // 重建后可检索命中
        let kb = state.repo.get_kb(&kb_id).unwrap().unwrap();
        let results = retrieve(&state, &kb, "quantum", 5).await.unwrap();
        assert!(!results.is_empty(), "reindexed kb should be retrievable");
        assert!(results.iter().any(|r| r.filename == "notes.md"));
    }

    #[tokio::test]
    async fn reindex_clears_needs_reindex_flag() {
        let base_url = spawn_mock(200).await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let dir = test_index_dir("reindex_clear_flag");
        *state.kb_index_dir.write() = dir.clone();

        state
            .repo
            .insert_channel(&channel("ch1", &base_url))
            .unwrap();
        let kb_id = "kb-reindex-clear-flag".to_string();
        state.repo.create_kb(&kb(&kb_id, Some("ch1"))).unwrap();

        let d = doc("doc-reindex-clear-flag", &kb_id, "notes.md");
        state.repo.insert_document(&d).unwrap();
        stage_content(&state, &d.id, b"# Title\n\nquantum computing basics").unwrap();
        spawn_ingest(state.clone(), d.id.clone());

        let indexed = wait_for_status(&state, &d.id, "indexed").await;
        assert!(indexed.chunk_count > 0, "doc should be ingested first");

        // 模拟 embedding model 变更,触发 needs_reindex 置位
        state
            .repo
            .update_kb_embedding_channel(
                &kb_id,
                Some("ch1".into()),
                "text-embedding-3-small-v2".into(),
            )
            .unwrap();
        assert!(
            state.repo.get_kb(&kb_id).unwrap().unwrap().needs_reindex,
            "flag should be set after embedding model change"
        );

        reindex_kb_contents(state.clone(), kb_id.clone())
            .await
            .unwrap();

        assert!(
            !state.repo.get_kb(&kb_id).unwrap().unwrap().needs_reindex,
            "flag should be cleared after successful reindex"
        );
    }
}
