//! MCP Server 冒烟测试：起真实网关 → rmcp client initialize + tools/list → 断言含 kb_list_bases。
//!
//! Task 2 起 /mcp 挂了 API key 鉴权（x-api-key / Bearer，仅校验不耗配额）：
//! - `mcp_lists_kb_tools` 走 rmcp client，经 transport 配置 `auth_header(Bearer 令牌)` 放行。
//! - `mcp_rejects_without_auth` 裸 reqwest POST /mcp 无鉴权头 → 断言 401。
//!
//! 复用 tests/common 的模式（内存 DB + `server::start`），无需 mock 上游（/mcp 不依赖渠道）。

use llm_gateway_lib::db::models::ApiKey;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};
use rmcp::model::ClientInfo;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ServiceExt, transport::StreamableHttpClientTransport};

const TEST_KEY: &str = "sk-lgw-mcp-test-key";

/// 向内存 DB 插入一个启用、无配额上限的 API key（鉴权只校验不耗配额）。
fn insert_test_key(state: &AppState) {
    state
        .repo
        .insert_api_key(&ApiKey {
            id: "k-mcp".into(),
            key: TEST_KEY.into(),
            name: "mcp-test".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 0,
            last_used_at: None,
        })
        .unwrap();
}

#[tokio::test]
async fn mcp_lists_kb_tools() -> anyhow::Result<()> {
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    insert_test_key(&state);
    let (_handle, addr) = server::start(state, 0)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    // rmcp client：transport 配置 Bearer 鉴权头（rmcp 的 auth_header 会自动加 "Bearer " 前缀，
    // 因此这里只传裸令牌）。
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::new(),
        StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/mcp"))
            .auth_header(TEST_KEY.to_string()),
    );
    let client = ClientInfo::default().serve(transport).await?;
    let tools = client.list_tools(None).await?;
    assert!(
        tools.tools.iter().any(|t| t.name == "kb_list_bases"),
        "expected kb_list_bases in tools: {:?}",
        tools.tools
    );
    Ok(())
}

#[tokio::test]
async fn mcp_rejects_without_auth() -> anyhow::Result<()> {
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    let (_handle, addr) = server::start(state, 0)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    // 裸 reqwest POST /mcp，不带任何鉴权头 → 应 401。
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/mcp"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#,
        )
        .send()
        .await?;
    assert_eq!(resp.status(), 401);
    Ok(())
}
