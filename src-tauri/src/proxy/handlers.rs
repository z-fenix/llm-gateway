use crate::auth::{self, AuthError};
use crate::db::models::RequestLog;
use crate::protocol::{anthropic, openai, types::ChatRequest};
use crate::proxy::forwarder::{self, ForwardError};
use crate::proxy::state::AppState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

fn extract_key(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.to_string());
    }
    if let Some(v) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(s) = v.strip_prefix("Bearer ") {
            return Some(s.to_string());
        }
    }
    None
}

fn err_response(status: StatusCode, code: &str, trace: &str) -> Response {
    (status, Json(json!({"error": {"code": code, "trace_id": trace}}))).into_response()
}

pub async fn health() -> &'static str {
    "ok"
}

pub async fn list_models(State(state): State<AppState>) -> impl IntoResponse {
    let mut models = vec!["sonnet", "opus", "fable", "haiku"]
        .into_iter()
        .map(|s| json!({"id": s, "object": "model"}))
        .collect::<Vec<_>>();
    if let Ok(chs) = state.repo.list_channels() {
        for c in chs.into_iter().filter(|c| c.enabled) {
            for m in c.models {
                models.push(json!({"id": m, "object": "model"}));
            }
        }
    }
    Json(json!({"object": "list", "data": models}))
}

pub async fn openai_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    handle(state, headers, body, Protocol::OpenAI).await
}

pub async fn anthropic_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    handle(state, headers, body, Protocol::Anthropic).await
}

#[derive(Clone, Copy, PartialEq)]
enum Protocol {
    OpenAI,
    Anthropic,
}

async fn handle(
    state: AppState,
    headers: HeaderMap,
    body: serde_json::Value,
    proto: Protocol,
) -> Response {
    let trace_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();

    // 1. auth
    let key = match extract_key(&headers) {
        Some(k) => k,
        None => return err_response(StatusCode::UNAUTHORIZED, "invalid_api_key", &trace_id),
    };
    let api_key = match auth::authorize(&state.repo, &key) {
        Ok(Ok(k)) => k,
        Ok(Err(AuthError::QuotaExceeded)) => {
            return err_response(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", &trace_id)
        }
        Ok(Err(AuthError::Disabled)) => {
            return err_response(StatusCode::UNAUTHORIZED, "api_key_disabled", &trace_id)
        }
        Ok(Err(AuthError::Invalid)) => {
            return err_response(StatusCode::UNAUTHORIZED, "invalid_api_key", &trace_id)
        }
        Err(_) => {
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &trace_id)
        }
    };

    // 2. parse to unified format
    let chat: ChatRequest = match proto {
        Protocol::OpenAI => match openai::request_to_chat(&body) {
            Ok(c) => c,
            Err(e) => return err_response(StatusCode::BAD_REQUEST, &e, &trace_id),
        },
        Protocol::Anthropic => match anthropic::request_to_chat(&body) {
            Ok(c) => c,
            Err(e) => return err_response(StatusCode::BAD_REQUEST, &e, &trace_id),
        },
    };
    let request_model = chat.model.clone();

    // 3. role detection
    let role = {
        let conn = state.db.conn();
        let conn = conn.lock().unwrap();
        crate::router::role::detect_role(&conn, &request_model)
    };

    // 4. role route
    let role_route = match &role {
        Some(r) => state
            .repo
            .get_role_route(r)
            .ok()
            .flatten()
            .map(|rr| (rr.channel_id, rr.target_model)),
        None => None,
    };

    // 5. forward
    let result = forwarder::forward(&state, &chat, role_route, &api_key,
    )
    .await;

    // 6. log + quota + response
    let latency = started.elapsed().as_millis() as i64;
    match result {
        Ok(fr) => {
            let o = &fr.outcome;
            let usage_total = (o.usage.input_tokens + o.usage.output_tokens) as i64;
            let _ = state.repo.consume_quota(&api_key.id, usage_total);
            write_log(
                &state, &trace_id, &api_key, Some(o), Some(&role), &request_model,
                proto, None, latency, &body,
            );
            let resp_body = match proto {
                Protocol::OpenAI => {
                    openai::chat_to_response(&to_chat_response(o, &request_model))
                }
                Protocol::Anthropic => {
                    anthropic::chat_to_response(&to_chat_response(o, &request_model))
                }
            };
            (StatusCode::OK, Json(resp_body)).into_response()
        }
        Err(e) => {
            let (status, code) = match &e {
                ForwardError::NoChannel => {
                    (StatusCode::SERVICE_UNAVAILABLE, "no_available_channel")
                }
                ForwardError::Upstream { status, .. } => {
                    (StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY), "upstream_error")
                }
                ForwardError::Http(_) => (StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            };
            write_log(
                &state, &trace_id, &api_key, None, Some(&role), &request_model,
                proto, Some(e.to_string()), latency, &body,
            );
            err_response(status, code, &trace_id)
        }
    }
}

fn to_chat_response(
    o: &forwarder::Outcome,
    model: &str,
) -> crate::protocol::types::ChatResponse {
    let raw = &o.body;
    let content = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .cloned()
        .or_else(|| raw.get("content").cloned())
        .unwrap_or(serde_json::Value::Null);
    let stop = raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .or_else(|| raw.get("stop_reason").and_then(|s| s.as_str()).map(|s| s.to_string()));
    crate::protocol::types::ChatResponse {
        id: raw.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        model: model.to_string(),
        content,
        stop_reason: stop,
        input_tokens: o.usage.input_tokens,
        output_tokens: o.usage.output_tokens,
        raw: raw.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_log(
    state: &AppState,
    trace_id: &str,
    api_key: &crate::db::models::ApiKey,
    o: Option<&forwarder::Outcome>,
    role: Option<&Option<String>>,
    request_model: &str,
    proto: Protocol,
    error: Option<String>,
    latency: i64,
    req_body: &serde_json::Value,
) {
    let seq = state.repo.next_log_seq().unwrap_or(1);
    let log = RequestLog {
        id: uuid::Uuid::new_v4().to_string(),
        seq,
        trace_id: trace_id.to_string(),
        api_key_id: Some(api_key.id.clone()),
        key_name: Some(api_key.name.clone()),
        channel_id: o.map(|x| x.channel.id.clone()),
        channel_name: o.map(|x| x.channel.name.clone()),
        role: role.cloned().flatten(),
        request_model: Some(request_model.to_string()),
        upstream_model: o.map(|x| x.model.clone()),
        protocol: match proto {
            Protocol::OpenAI => "openai".into(),
            Protocol::Anthropic => "anthropic".into(),
        },
        status_code: o.map(|x| x.status as i64),
        input_tokens: o.map(|x| x.usage.input_tokens as i64).unwrap_or(0),
        output_tokens: o.map(|x| x.usage.output_tokens as i64).unwrap_or(0),
        latency_ms: latency,
        is_stream: false,
        error,
        fallback: o.map(|x| x.via_fallback).unwrap_or(false),
        tool_calls: None,
        request_body: Some(req_body.to_string()),
        response_body: o.map(|x| x.body.to_string()),
        created_at: chrono::Utc::now().timestamp(),
    };
    let _ = state.repo.insert_log(&log);
}
