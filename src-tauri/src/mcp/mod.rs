pub mod tools;

use crate::proxy::state::AppState;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

/// MCP Server 路由(Streamable HTTP)。当前只挂 `/mcp`,鉴权在 Task 2 接入。
/// 返回 `Router<AppState>` 以与网关主路由(state 为 `AppState`)merge。
pub fn mcp_router(state: AppState) -> axum::Router<AppState> {
    let service_state = state.clone();
    let service: StreamableHttpService<tools::KbMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(tools::KbMcpServer::new(service_state.clone())),
            Default::default(),
            StreamableHttpServerConfig::default(),
        );
    axum::Router::new()
        .nest_service("/mcp", service)
        .with_state(state)
}
