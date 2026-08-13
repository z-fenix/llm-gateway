//! MCP Server 最小冒烟测试：起真实网关 → rmcp client initialize + tools/list → 断言含 kb_list_bases。
//!
//! 复用 tests/common 的模式（内存 DB + `server::start`），无需 mock 上游（/mcp 不依赖渠道）。

use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};
use rmcp::model::ClientInfo;
use rmcp::{ServiceExt, transport::StreamableHttpClientTransport};

#[tokio::test]
async fn mcp_lists_kb_tools() -> anyhow::Result<()> {
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    let (_handle, addr) = server::start(state, 0)
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

    let transport = StreamableHttpClientTransport::from_uri(format!("http://{addr}/mcp"));
    let client = ClientInfo::default().serve(transport).await?;
    let tools = client.list_tools(None).await?;
    assert!(
        tools.tools.iter().any(|t| t.name == "kb_list_bases"),
        "expected kb_list_bases in tools: {:?}",
        tools.tools
    );
    Ok(())
}
