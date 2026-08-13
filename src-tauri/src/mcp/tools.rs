use crate::db::models::KnowledgeBase;
use crate::knowledge::retrieve::retrieve;
use crate::proxy::state::AppState;
use rmcp::{
    handler::server::wrapper::Parameters,
    handler::server::ServerHandler,
    model::{CallToolResult, ContentBlock},
    tool, tool_handler, tool_router,
};

#[derive(Clone)]
pub struct KbMcpServer {
    state: AppState,
}

impl KbMcpServer {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// 定位知识库:传值则先按 id、失败按 name,不传用 `rag.default_kb`。
    fn resolve_kb(&self, kb_id: Option<String>) -> Result<KnowledgeBase, String> {
        let id = match kb_id {
            Some(id) => id,
            None => self
                .state
                .rag
                .read()
                .default_kb
                .clone()
                .ok_or_else(|| "no kb specified and no default_kb".to_string())?,
        };
        if let Some(kb) = self.state.repo.get_kb(&id).map_err(|e| e.to_string())? {
            return Ok(kb);
        }
        self.state
            .repo
            .get_kb_by_name(&id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("knowledge base not found: {id}"))
    }

    /// 列出所有知识库,返回 JSON 数组文本。
    pub async fn do_kb_list_bases(&self) -> Result<String, String> {
        let kbs = self.state.repo.list_kbs().map_err(|e| e.to_string())?;
        serde_json::to_string(&kbs).map_err(|e| e.to_string())
    }

    /// 获取知识库详情(按 id 或 name 定位)+ 实时文档数,返回 JSON 文本。
    pub async fn do_kb_get_base(&self, kb_id: String) -> Result<String, String> {
        let kb = self.resolve_kb(Some(kb_id))?;
        let doc_count = self
            .state
            .repo
            .list_documents(&kb.id)
            .map_err(|e| e.to_string())?
            .len();
        let mut value = serde_json::to_value(&kb).map_err(|e| e.to_string())?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("doc_count".into(), serde_json::json!(doc_count));
        }
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }

    /// 混合检索知识库片段(向量 + FTS,RRF 融合),返回 JSON 数组文本。
    pub async fn do_kb_search(
        &self,
        query: String,
        kb_id: Option<String>,
        top_k: Option<usize>,
    ) -> Result<String, String> {
        let kb = self.resolve_kb(kb_id)?;
        let top_k = top_k.unwrap_or(5).min(20);
        let chunks = retrieve(&self.state, &kb, &query, top_k).await?;
        serde_json::to_string(&chunks).map_err(|e| e.to_string())
    }
}

#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct KbSearchArgs {
    pub query: String,
    #[schemars(description = "知识库 id 或 name;缺省用 rag.default_kb")]
    pub kb_id: Option<String>,
    #[schemars(description = "返回片段数,默认 5,上限 20")]
    pub top_k: Option<usize>,
}

#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct KbGetBaseArgs {
    pub kb_id: String,
}

#[tool_router]
impl KbMcpServer {
    /// 列出所有知识库
    #[tool(name = "kb_list_bases", description = "列出所有知识库")]
    pub async fn kb_list_bases(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        self.do_kb_list_bases()
            .await
            .map(|json| CallToolResult::success(vec![ContentBlock::text(json)]))
            .map_err(|e| {
                rmcp::model::ErrorData::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e, None)
            })
    }

    /// 获取知识库详情(含文档数)
    #[tool(name = "kb_get_base", description = "获取知识库详情(含文档数)")]
    pub async fn kb_get_base(
        &self,
        Parameters(args): Parameters<KbGetBaseArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        self.do_kb_get_base(args.kb_id)
            .await
            .map(|json| CallToolResult::success(vec![ContentBlock::text(json)]))
            .map_err(|e| {
                rmcp::model::ErrorData::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e, None)
            })
    }

    /// 按 query 检索知识库片段
    #[tool(name = "kb_search", description = "按 query 检索知识库片段")]
    pub async fn kb_search(
        &self,
        Parameters(args): Parameters<KbSearchArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        self.do_kb_search(args.query, args.kb_id, args.top_k)
            .await
            .map(|json| CallToolResult::success(vec![ContentBlock::text(json)]))
            .map_err(|e| {
                rmcp::model::ErrorData::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e, None)
            })
    }
}

#[tool_handler]
impl ServerHandler for KbMcpServer {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{Channel, KbDocument};
    use crate::db::Db;
    use crate::knowledge::ingest::{spawn_ingest, stage_content};
    use axum::{routing::post, Json, Router};
    use serde_json::Value;
    use std::net::SocketAddr;
    use std::path::Path;
    use std::time::Duration;

    fn embedding_channel(id: &str, base_url: &str) -> Channel {
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

    fn kb(id: &str, name: &str) -> KnowledgeBase {
        KnowledgeBase {
            id: id.into(),
            name: name.into(),
            description: None,
            embedding_channel_id: Some("emb".into()),
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

    fn doc(id: &str, kb_id: &str) -> KbDocument {
        KbDocument {
            id: id.into(),
            kb_id: kb_id.into(),
            filename: "notes.md".into(),
            file_type: "md".into(),
            size_bytes: 0,
            chunk_count: 0,
            status: "indexing".into(),
            error: None,
            created_at: 1,
        }
    }

    fn test_index_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("llm-gateway")
            .join("kb")
            .join(format!("mcp_tools_{}_{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 固定返回 4 维向量的 mock /v1/embeddings 上游,返回 base_url。
    async fn spawn_mock_embeddings() -> String {
        let app = Router::new().route(
            "/v1/embeddings",
            post(move |Json(v): Json<Value>| async move {
                let input = v["input"].as_array().cloned().unwrap_or_default();
                let data: Vec<Value> = input
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        serde_json::json!({
                            "object": "embedding",
                            "index": i,
                            "embedding": [0.5f32, 0.5, 0.5, 0.5]
                        })
                    })
                    .collect();
                (
                    axum::http::StatusCode::OK,
                    Json(serde_json::json!({ "object": "list", "data": data })),
                )
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

    /// 造 AppState(内存 DB + temp 索引 + mock embedding),建库并摄取一文档,等待 indexed。
    /// 返回 KbMcpServer 以调用 do_* 核心逻辑函数。
    async fn setup_rag(
        index_dir: &Path,
        kb_id: &str,
        kb_name: &str,
        doc_id: &str,
        content: &[u8],
    ) -> KbMcpServer {
        let base_url = spawn_mock_embeddings().await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        *state.kb_index_dir.write() = index_dir.to_path_buf();

        state
            .repo
            .insert_channel(&embedding_channel("emb", &base_url))
            .unwrap();
        state.repo.create_kb(&kb(kb_id, kb_name)).unwrap();

        let d = doc(doc_id, kb_id);
        state.repo.insert_document(&d).unwrap();
        stage_content(&state, &d.id, content).unwrap();
        spawn_ingest(state.clone(), d.id.clone());
        wait_for_status(&state, &d.id, "indexed").await;

        KbMcpServer::new(state)
    }

    #[tokio::test]
    async fn kb_search_uses_default_kb_when_id_omitted() {
        let dir = test_index_dir("default_kb");
        let server = setup_rag(
            &dir,
            "kb-1",
            "kb1",
            "doc-1",
            b"quantum computing basics and entanglement explained",
        )
        .await;
        server.state.rag.write().default_kb = Some("kb1".into());

        let json = server
            .do_kb_search("quantum".to_string(), None, None)
            .await
            .unwrap();
        let arr: Vec<Value> = serde_json::from_str(&json).unwrap();
        assert!(!arr.is_empty(), "search should hit the ingested doc: {json}");
        assert!(
            json.contains("quantum"),
            "chunk content should be present: {json}"
        );
        assert!(
            json.contains("notes.md"),
            "chunk source filename should be present: {json}"
        );
    }

    #[tokio::test]
    async fn kb_search_resolves_by_name_and_caps_top_k() {
        let dir = test_index_dir("by_name_cap");
        let server = setup_rag(
            &dir,
            "kb-1",
            "kb1",
            "doc-1",
            b"quantum computing basics and entanglement explained",
        )
        .await;

        // 传 name(kb1) 而非 id(kb-1);top_k=999 应被截断到 20,retrieve 不报错。
        let json = server
            .do_kb_search("quantum".to_string(), Some("kb1".into()), Some(999))
            .await
            .unwrap();
        let arr: Vec<Value> = serde_json::from_str(&json).unwrap();
        assert!(arr.len() <= 20);
        assert!(!arr.is_empty(), "search by name should hit: {json}");
    }

    #[tokio::test]
    async fn kb_get_base_resolves_id_or_name_and_errors_when_missing() {
        let dir = test_index_dir("get_base");
        let server = setup_rag(&dir, "kb-1", "kb1", "doc-1", b"quantum computing basics").await;

        let by_name = server.do_kb_get_base("kb1".into()).await.unwrap();
        assert!(by_name.contains("\"name\":\"kb1\""), "{by_name}");
        let by_id = server.do_kb_get_base("kb-1".into()).await.unwrap();
        assert!(by_id.contains("\"id\":\"kb-1\""), "{by_id}");

        let err = server.do_kb_get_base("nope".into()).await.unwrap_err();
        assert!(
            err.contains("nope"),
            "error should name the missing base: {err}"
        );
    }

    #[tokio::test]
    async fn kb_list_bases_returns_json_array() {
        let base_url = spawn_mock_embeddings().await;
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state
            .repo
            .insert_channel(&embedding_channel("emb", &base_url))
            .unwrap();
        state.repo.create_kb(&kb("kb-a", "kba")).unwrap();
        state.repo.create_kb(&kb("kb-b", "kbb")).unwrap();
        let server = KbMcpServer::new(state);

        let json = server.do_kb_list_bases().await.unwrap();
        let arr: Vec<Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(arr.len(), 2);
    }
}
