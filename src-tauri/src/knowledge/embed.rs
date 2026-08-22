use crate::db::models::{Channel, KnowledgeBase};
use crate::provider::adapter::auth_header;
use crate::proxy::state::AppState;
use parking_lot::RwLock;
use serde::Deserialize;
use std::sync::Arc;

const BATCH_SIZE: usize = 32;

pub struct Embedder {
    channel: Channel,
    model: String,
    client: reqwest::Client,
    dim: Arc<RwLock<Option<usize>>>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    #[serde(default)]
    index: Option<usize>,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

impl Embedder {
    pub fn from_kb(state: &AppState, kb: &KnowledgeBase) -> Result<Embedder, String> {
        let channel_id = kb
            .embedding_channel_id
            .clone()
            .or_else(|| state.rag.read().default_embedding_channel.clone())
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "embedding channel not configured".to_string())?;
        let channel = state
            .repo
            .get_channel(&channel_id)
            .map_err(|_| "embedding channel lookup failed".to_string())?
            .ok_or_else(|| "embedding channel not found".to_string())?;
        Ok(Embedder {
            channel,
            model: kb.embedding_model.clone(),
            client: state.http.clone(),
            dim: Arc::new(RwLock::new(None)),
        })
    }

    pub fn dim(&self) -> Option<usize> {
        *self.dim.read()
    }

    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut all = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH_SIZE) {
            let batch = self.embed_batch(chunk).await?;
            all.extend(batch);
        }
        Ok(all)
    }

    async fn embed_batch(&self, chunk: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let url = format!(
            "{}/v1/embeddings",
            self.channel.base_url.trim_end_matches('/')
        );
        let body = serde_json::json!({
            "model": self.model,
            "input": chunk,
        });
        let (header_name, header_value) =
            auth_header(&self.channel.upstream_protocol, &self.channel.api_key)
                .ok_or_else(|| "unsupported auth for upstream protocol".to_string())?;
        let resp = self
            .client
            .post(&url)
            .header(header_name, header_value)
            .json(&body)
            .send()
            .await
            .map_err(|_| "embedding request failed".to_string())?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!(
                "embedding upstream error: status {}",
                status.as_u16()
            ));
        }
        let parsed: EmbeddingResponse = resp
            .json()
            .await
            .map_err(|_| "embedding response invalid".to_string())?;
        let mut items: Vec<(usize, Vec<f32>)> = parsed
            .data
            .into_iter()
            .enumerate()
            .map(|(pos, item)| (item.index.unwrap_or(pos), item.embedding))
            .collect();
        items.sort_by_key(|(idx, _)| *idx);
        if items.len() != chunk.len() {
            return Err("embedding index mismatch".to_string());
        }
        for (i, (idx, _)) in items.iter().enumerate() {
            if *idx != i {
                return Err("embedding index mismatch".to_string());
            }
        }
        let mut out = Vec::with_capacity(items.len());
        for (_, vec) in items {
            let current_dim = *self.dim.read();
            match current_dim {
                Some(expected) => {
                    if vec.len() != expected {
                        return Err("embedding dimension mismatch".to_string());
                    }
                }
                None => *self.dim.write() = Some(vec.len()),
            }
            out.push(vec);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use axum::{extract::State, routing::post, Json, Router};
    use serde_json::Value;
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct MockUpstream {
        hits: Arc<Mutex<Vec<Value>>>,
        status: Arc<Mutex<u16>>,
        body: Arc<Mutex<Value>>,
    }

    async fn spawn_mock(status: u16, body: Value) -> (String, MockUpstream) {
        let state = MockUpstream {
            hits: Arc::new(Mutex::new(vec![])),
            status: Arc::new(Mutex::new(status)),
            body: Arc::new(Mutex::new(body)),
        };
        let app = Router::new()
            .route(
                "/v1/embeddings",
                post(|st: State<MockUpstream>, Json(v): Json<Value>| async move {
                    st.hits.lock().unwrap().push(v);
                    let status = *st.status.lock().unwrap();
                    let body = st.body.lock().unwrap().clone();
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(body),
                    )
                }),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{}", addr), state)
    }

    fn test_channel(id: &str, base_url: &str) -> Channel {
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

    fn test_kb(channel_id: Option<&str>) -> KnowledgeBase {
        KnowledgeBase {
            id: "kb1".into(),
            name: "test".into(),
            description: None,
            embedding_channel_id: channel_id.map(|s| s.into()),
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

    #[tokio::test]
    async fn embed_returns_vectors_aligned() {
        let (base_url, _) = spawn_mock(
            200,
            serde_json::json!({
                "object": "list",
                "data": [
                    {"object": "embedding", "index": 2, "embedding": [0.0, 0.0, 0.0, 1.0]},
                    {"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]},
                    {"object": "embedding", "index": 1, "embedding": [0.0, 1.0, 0.0, 0.0]},
                ]
            }),
        )
        .await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state
            .repo
            .insert_channel(&test_channel("ch1", &base_url))
            .unwrap();
        let kb = test_kb(Some("ch1"));
        let embedder = Embedder::from_kb(&state, &kb).unwrap();
        let vecs = embedder
            .embed(&["a".into(), "b".into(), "c".into()])
            .await
            .unwrap();

        assert_eq!(vecs.len(), 3);
        assert_eq!(vecs[0], vec![1.0, 0.0, 0.0, 0.0]);
        assert_eq!(vecs[1], vec![0.0, 1.0, 0.0, 0.0]);
        assert_eq!(vecs[2], vec![0.0, 0.0, 0.0, 1.0]);
        assert_eq!(embedder.dim(), Some(4));
    }

    #[tokio::test]
    async fn embed_batches_over_32() {
        let texts: Vec<String> = (0..40).map(|i| format!("text {}", i)).collect();

        // 动态 mock：根据请求 input 长度返回对应数量的向量，以验证分批。
        let hits = Arc::new(Mutex::new(Vec::new()));
        let hits_clone = hits.clone();
        let app = Router::new().route(
            "/v1/embeddings",
            post(move |Json(v): Json<Value>| async move {
                hits_clone.lock().unwrap().push(v.clone());
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
                    Json(serde_json::json!({ "data": data })),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let base_url = format!("http://{}", addr);

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state
            .repo
            .insert_channel(&test_channel("ch1", &base_url))
            .unwrap();
        let kb = test_kb(Some("ch1"));
        let embedder = Embedder::from_kb(&state, &kb).unwrap();
        let vecs = embedder.embed(&texts).await.unwrap();

        assert_eq!(vecs.len(), 40);
        let hits = hits.lock().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["input"].as_array().unwrap().len(), 32);
        assert_eq!(hits[1]["input"].as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn embed_index_mismatch_rejects() {
        let (base_url, _) = spawn_mock(
            200,
            serde_json::json!({
                "object": "list",
                "data": [
                    {"object": "embedding", "index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]},
                    {"object": "embedding", "index": 0, "embedding": [0.0, 1.0, 0.0, 0.0]},
                    {"object": "embedding", "index": 1, "embedding": [0.0, 0.0, 0.0, 1.0]},
                ]
            }),
        )
        .await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state
            .repo
            .insert_channel(&test_channel("ch1", &base_url))
            .unwrap();
        let kb = test_kb(Some("ch1"));
        let embedder = Embedder::from_kb(&state, &kb).unwrap();
        let err = embedder
            .embed(&["a".into(), "b".into(), "c".into()])
            .await
            .unwrap_err();

        assert!(
            err.contains("index mismatch"),
            "error should indicate index mismatch: {}",
            err
        );
    }

    #[tokio::test]
    async fn embed_upstream_error_surfaces() {
        let (base_url, _) = spawn_mock(500, serde_json::json!({ "error": "boom" })).await;

        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let mut channel = test_channel("ch1", &base_url);
        channel.api_key = "sk-secret-key".into();
        state.repo.insert_channel(&channel).unwrap();
        let kb = test_kb(Some("ch1"));
        let embedder = Embedder::from_kb(&state, &kb).unwrap();
        let err = embedder.embed(&["a".into(), "b".into()]).await.unwrap_err();

        assert!(
            err.contains("upstream error"),
            "error should indicate upstream failure: {}",
            err
        );
        assert!(
            !err.contains("sk-secret-key"),
            "error must not leak api key: {}",
            err
        );
        assert!(
            !err.contains("boom"),
            "error must not leak upstream body: {}",
            err
        );
    }
}
