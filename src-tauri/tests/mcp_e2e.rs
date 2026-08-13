//! MCP Server 端到端集成测试(经真实网关):鉴权 → 7 工具全链路 → embedding 降级。
//!
//! 与 `mcp_smoke.rs`(仅 initialize + tools/list 冒烟)不同,本文件走完整 MCP 会话:
//! - setup:内存 DB + temp kb 索引目录 + mock embedding(定维 4 维向量)+ mock chat 上游,
//!   `server::start` 起真实网关,rmcp client transport 带 `auth_header(裸令牌)`(rmcp 内部加 "Bearer ")。
//! - 覆盖:tools/list 7 工具齐全;kb_create→kb_upload→轮询 indexed→kb_search 命中→
//!   kb_get_base→kb_delete;stats_quota 数值字段;401(无鉴权 / 有效 key 但禁用);
//!   embedding 切 500 时 kb_search 返回 MCP error(JSON-RPC error,HTTP 仍 2xx 级),不 panic。
//!
//! 安全回归:本文件不写 api_key 字段、不写 request_body/response_body(见 mcp/mod.rs/auth.rs)。

mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};
use rmcp::model::{CallToolRequestParams, ClientInfo};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ServiceError, ServiceExt};
use std::net::SocketAddr;
use std::time::Duration;

const TEST_KEY: &str = "sk-lgw-mcp-e2e-key";

const TOOL_NAMES: [&str; 7] = [
    "kb_list_bases",
    "kb_get_base",
    "kb_search",
    "kb_create",
    "kb_upload",
    "kb_delete",
    "stats_quota",
];

/// rmcp client 具体类型(ClientInfo::default().serve(transport) 的返回)。
type McpClient = rmcp::service::RunningService<rmcp::service::RoleClient, rmcp::model::ClientInfo>;

fn api_key(enabled: bool) -> ApiKey {
    ApiKey {
        id: "k-mcp-e2e".into(),
        key: TEST_KEY.into(),
        name: "mcp-e2e".into(),
        enabled,
        quota_total: None,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: 0,
        last_used_at: None,
    }
}

/// embedding 上游渠道:低优先级,只服务 /v1/embeddings(MCP 工具不依赖聊天渠道)。
fn embedding_channel(id: &str, base_url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
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

fn ok_chat_body() -> serde_json::Value {
    serde_json::json!({
        "id": "c1",
        "object": "chat.completion",
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })
}

struct TestEnv {
    state: AppState,
    addr: SocketAddr,
    client: McpClient,
    mocks: common::MockWithEmbeddings,
    /// 保持 temp kb 索引目录存活到测试结束。
    _temp: tempfile::TempDir,
    /// 保持网关 serve 任务句柄(丢弃不影响运行,仅用于确定性)。
    _handle: tokio::task::JoinHandle<()>,
}

/// 公共 setup:mock 双上游 + 内存 DB + 启用 API key + embedding 渠道,起网关并连上 rmcp client。
async fn setup() -> TestEnv {
    let (_chat_base, embed_base, mocks) =
        common::spawn_mock_with_embeddings(200, ok_chat_body(), 200).await;
    let temp = tempfile::tempdir().unwrap();
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    *state.kb_index_dir.write() = temp.path().to_path_buf();
    state.repo.insert_api_key(&api_key(true)).unwrap();
    state.repo.insert_channel(&embedding_channel("emb", &embed_base)).unwrap();

    let (_handle, addr) = server::start(state.clone(), 0).await.unwrap();
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::new(),
        StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/mcp"))
            .auth_header(TEST_KEY.to_string()),
    );
    let client = ClientInfo::default().serve(transport).await.unwrap();
    TestEnv {
        state,
        addr,
        client,
        mocks,
        _temp: temp,
        _handle,
    }
}

/// 取出工具返回的首段文本内容。
fn tool_text(result: &rmcp::model::CallToolResult) -> String {
    result
        .content
        .first()
        .and_then(|c| c.as_text())
        .map(|t| t.text.as_str())
        .expect("tool should return text content")
        .to_string()
}

/// 调用工具并返回文本;`args == None` 时不带 arguments(如 stats_quota)。
async fn call_tool_text(client: &McpClient, name: &str, args: Option<serde_json::Value>) -> String {
    let mut params = CallToolRequestParams::new(name.to_string());
    if let Some(args) = args {
        params = params.with_arguments(args.as_object().cloned().unwrap_or_default());
    }
    let result = client
        .call_tool(params)
        .await
        .expect("tool call should succeed");
    tool_text(&result)
}

/// 轮询直到文档进入 indexed;失败或超时 panic,保证确定性。
async fn wait_for_indexed(state: &AppState, doc_id: &str) {
    for _ in 0..300 {
        if let Some(d) = state.repo.get_document(doc_id).unwrap() {
            if d.status == "indexed" {
                return;
            }
            if d.status == "failed" {
                panic!("document {doc_id} failed: {:?}", d.error);
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for document {doc_id} to be indexed");
}

/// 建库并摄取一文档(经真实 MCP 工具),返回 (kb_id, doc_id)。
async fn create_kb_and_upload(env: &TestEnv) -> (String, String) {
    let create_json = call_tool_text(
        &env.client,
        "kb_create",
        Some(serde_json::json!({
            "name": "e2e-kb",
            "embedding_channel_id": "emb",
            "embedding_model": "text-embedding-3-small",
        })),
    )
    .await;
    let create_v: serde_json::Value = serde_json::from_str(&create_json).unwrap();
    assert_eq!(create_v["name"], "e2e-kb");
    assert_eq!(create_v["enabled"], true);
    let kb_id = create_v["id"].as_str().unwrap().to_string();

    let upload_json = call_tool_text(
        &env.client,
        "kb_upload",
        Some(serde_json::json!({
            "kb_id": kb_id,
            "filename": "notes.md",
            "content": "quantum computing basics and entanglement explained",
        })),
    )
    .await;
    let upload_v: serde_json::Value = serde_json::from_str(&upload_json).unwrap();
    assert_eq!(upload_v["status"], "indexing");
    assert_eq!(upload_v["file_type"], "md");
    let doc_id = upload_v["id"].as_str().unwrap().to_string();

    (kb_id, doc_id)
}

/// 从 HTTP 响应体提取首个 JSON 消息(兼容 `application/json` 与 `text/event-stream` 的 `data:` 行)。
async fn body_json(resp: reqwest::Response) -> serde_json::Value {
    let text = resp.text().await.unwrap();
    let text = text.trim();
    if text.starts_with('{') {
        return serde_json::from_str(text).unwrap();
    }
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.trim();
            if !rest.is_empty() {
                return serde_json::from_str(rest).unwrap();
            }
        }
    }
    panic!("no JSON message found in response body: {text}");
}

/// 原始 reqwest 走完 MCP Streamable HTTP 会话(initialize → initialized → tools/call),
/// 返回 (HTTP status, JSON-RPC 响应体)。用于直接断言 HTTP 层状态(降级场景下应 2xx + JSON-RPC error)。
async fn raw_mcp_tools_call(
    addr: SocketAddr,
    key: &str,
    name: &str,
    args: serde_json::Value,
) -> (reqwest::StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let url = format!("http://{addr}/mcp");

    // 1. initialize(响应为 SSE 流,首条 data: 即 initialize 结果;会话 id 在响应头)。
    let init_resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"raw-e2e","version":"1"}}}"#,
        )
        .send()
        .await
        .unwrap();
    assert_eq!(init_resp.status(), reqwest::StatusCode::OK);
    let session_id = init_resp
        .headers()
        .get("mcp-session-id")
        .expect("initialize should return Mcp-Session-Id")
        .to_str()
        .unwrap()
        .to_string();
    let _ = body_json(init_resp).await;

    // 2. initialized 通知(202 Accepted,空体)。
    let notif_resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .body(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .send()
        .await
        .unwrap();
    assert!(
        notif_resp.status().is_success(),
        "initialized notification should be accepted: {}",
        notif_resp.status()
    );

    // 3. tools/call
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": name, "arguments": args }
    });
    let call_resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-session-id", &session_id)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = call_resp.status();
    let parsed = body_json(call_resp).await;
    (status, parsed)
}

/// 用例 1:initialize → tools/list → 断言 7 个工具齐全。
#[tokio::test]
async fn mcp_tools_list_exposes_all_seven_tools() {
    let env = setup().await;
    let tools = env.client.list_tools(None).await.unwrap();
    let mut names: Vec<String> = tools.tools.iter().map(|t| t.name.to_string()).collect();
    let mut expected: Vec<String> = TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    names.sort_unstable();
    expected.sort_unstable();
    assert_eq!(names, expected, "tool list should contain exactly the 7 kb/stats tools");
}

/// 用例 2:全链路 —— kb_create → kb_upload → 轮询 indexed → kb_search 命中 → kb_get_base → kb_delete。
#[tokio::test]
async fn mcp_kb_lifecycle_full_flow() {
    let env = setup().await;

    let (kb_id, doc_id) = create_kb_and_upload(&env).await;
    wait_for_indexed(&env.state, &doc_id).await;

    // kb_search:命中摄取的关键词文档
    let search_json = call_tool_text(
        &env.client,
        "kb_search",
        Some(serde_json::json!({ "query": "quantum entanglement", "kb_id": kb_id })),
    )
    .await;
    let hits: Vec<serde_json::Value> = serde_json::from_str(&search_json).unwrap();
    assert!(!hits.is_empty(), "search should hit the ingested doc: {search_json}");
    assert!(search_json.contains("quantum"), "chunk content should be present: {search_json}");
    assert!(
        search_json.contains("notes.md"),
        "chunk source filename should be present: {search_json}"
    );

    // kb_get_base:含实时文档数
    let get_json = call_tool_text(
        &env.client,
        "kb_get_base",
        Some(serde_json::json!({ "kb_id": kb_id })),
    )
    .await;
    let get_v: serde_json::Value = serde_json::from_str(&get_json).unwrap();
    assert_eq!(get_v["name"], "e2e-kb");
    assert!(
        get_v["doc_count"].as_i64().unwrap() >= 1,
        "doc_count should reflect the ingested doc: {get_json}"
    );

    // kb_delete:级联删除库行
    let del_json = call_tool_text(
        &env.client,
        "kb_delete",
        Some(serde_json::json!({ "kb_id": kb_id })),
    )
    .await;
    let del_v: serde_json::Value = serde_json::from_str(&del_json).unwrap();
    assert_eq!(del_v["deleted"], true);
    assert_eq!(del_v["kb_id"], kb_id);
    assert!(
        env.state.repo.get_kb(&kb_id).unwrap().is_none(),
        "kb row should be gone after delete"
    );
}

/// 用例 3:stats_quota 返回数值字段。
#[tokio::test]
async fn mcp_stats_quota_returns_numeric_aggregates() {
    let env = setup().await;
    let json = call_tool_text(&env.client, "stats_quota", None).await;
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for field in [
        "today_requests",
        "today_tokens",
        "total_requests",
        "total_tokens",
        "active_channels",
        "avg_latency_ms",
    ] {
        assert!(v[field].is_number(), "{field} should be numeric: {json}");
    }
    // setup 插入了一个启用渠道,活跃渠道数应 >= 1
    assert!(v["active_channels"].as_i64().unwrap() >= 1, "{json}");
}

/// 用例 4:401 —— 无鉴权头 POST /mcp;以及有效 key 但 enabled=false → 401。
#[tokio::test]
async fn mcp_rejects_missing_auth_and_disabled_key() {
    let init_body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;

    // 无鉴权头 → 401
    let env = setup().await;
    let resp = reqwest::Client::new()
        .post(format!("http://{}/mcp", env.addr))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(init_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401, "missing auth must be rejected");

    // 有效 key 但禁用 → 401
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    state.repo.insert_api_key(&api_key(false)).unwrap();
    let (_h, addr) = server::start(state, 0).await.unwrap();
    let resp2 = reqwest::Client::new()
        .post(format!("http://{addr}/mcp"))
        .header("authorization", format!("Bearer {TEST_KEY}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(init_body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), 401, "disabled key must be rejected");
}

/// 用例 5:降级 —— embedding mock 切 500 后,kb_search 返回 MCP error(JSON-RPC error,
/// HTTP 仍 2xx 级),不 panic,后续请求仍正常。
#[tokio::test]
async fn mcp_embedding_500_returns_mcp_error_not_http_5xx() {
    let env = setup().await;
    let (kb_id, doc_id) = create_kb_and_upload(&env).await;
    wait_for_indexed(&env.state, &doc_id).await;

    // 摄取完成后把 embedding 上游切到 500,模拟检索期故障。
    *env.mocks.embeddings.respond_status.lock().unwrap() = 500;

    let res = env
        .client
        .call_tool(
            CallToolRequestParams::new("kb_search").with_arguments(
                serde_json::json!({ "query": "quantum", "kb_id": kb_id })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ),
        )
        .await;
    match res {
        // MCP error:JSON-RPC error。rmcp 的 jsonrpc_http_status 将 INTERNAL_ERROR 映射为
        // HTTP 200,因此这里收到 McpError(而非 HTTP 层错误)即证明网关返回 2xx 级。
        Err(ServiceError::McpError(e)) => {
            assert_eq!(
                e.code,
                rmcp::model::ErrorCode::INTERNAL_ERROR,
                "tool error should be INTERNAL_ERROR(-32603): {:?}",
                e
            );
            assert!(
                e.message.contains("embedding"),
                "error should reference the embedding failure: {:?}",
                e
            );
        }
        other => panic!("expected MCP tool error (JSON-RPC error), got: {other:?}"),
    }

    // 直接断言 HTTP 层:新会话经原始 reqwest 调 kb_search,应 2xx 且 body 是 JSON-RPC error(-32603),
    // 而非 HTTP 5xx。rmcp 的 jsonrpc_http_status 将 INTERNAL_ERROR 映射为 HTTP 200。
    let (status, jsonrpc) = raw_mcp_tools_call(
        env.addr,
        TEST_KEY,
        "kb_search",
        serde_json::json!({ "query": "quantum", "kb_id": kb_id }),
    )
    .await;
    assert!(
        status.is_success(),
        "gateway should answer the degraded tool call with 2xx, got HTTP {status}: {jsonrpc}"
    );
    assert_eq!(
        jsonrpc["error"]["code"],
        -32603,
        "expected JSON-RPC INTERNAL_ERROR in body: {jsonrpc}"
    );

    // 服务器未 panic:错误后同一 rmcp 会话内 list_tools 仍正常。
    let tools = env.client.list_tools(None).await.unwrap();
    assert_eq!(tools.tools.len(), TOOL_NAMES.len());
}
