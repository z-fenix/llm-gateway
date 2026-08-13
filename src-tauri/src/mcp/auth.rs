use crate::auth;
use crate::proxy::handlers::extract_key;
use crate::proxy::state::AppState;
use axum::{
    extract::{Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// /mcp 鉴权：复用 API key 校验（x-api-key 或 Bearer），仅校验不耗配额。
///
/// 鉴权失败（无 key / key 无效 / 已禁用 / 配额超限 / DB 错误）一律 401，不泄露细节。
/// 通过后继续执行 MCP 服务。
pub async fn mcp_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let Some(key) = extract_key(&headers) else {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    };
    match auth::authorize(&state.repo, &key) {
        Ok(Ok(_)) => next.run(request).await,
        _ => (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response(),
    }
}
