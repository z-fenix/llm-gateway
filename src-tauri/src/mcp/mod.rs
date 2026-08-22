pub mod auth;
pub mod tools;

use crate::proxy::state::AppState;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

/// MCP Server 路由(Streamable HTTP),挂 `/mcp`。Task 2 起 /mcp 全部请求先过 API key 鉴权
/// (`auth::mcp_auth`,仅校验不耗配额)。
/// 返回 `Router<AppState>` 以与网关主路由(state 为 `AppState`)merge。
///
/// state 所有权:clone 给 factory 闭包(造 KbMcpServer)、clone 给鉴权中间件
/// (`from_fn_with_state`),原 state 留给 `.with_state(state)`。
pub fn mcp_router(state: AppState) -> axum::Router<AppState> {
    let factory_state = state.clone();
    let service: StreamableHttpService<tools::KbMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(tools::KbMcpServer::new(factory_state.clone())),
            Default::default(),
            StreamableHttpServerConfig::default(),
        );
    let auth_state = state.clone();
    axum::Router::new()
        .nest_service("/mcp", service)
        .route_layer(axum::middleware::from_fn_with_state(
            auth_state,
            auth::mcp_auth,
        ))
        .with_state(state)
}
