use crate::auth::{self, AuthError};
use crate::db::models::RequestLog;
use crate::protocol::{anthropic, openai, types::ChatRequest};
use crate::proxy::forwarder::{self, ForwardError};
use crate::proxy::security_hook::{self, RequestVerdict};
use crate::proxy::state::AppState;
use crate::security::{SecurityAction, SecurityScanResult};
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

fn log_failure(
    state: &AppState,
    trace_id: &str,
    api_key: Option<&crate::db::models::ApiKey>,
    proto: Protocol,
    status: StatusCode,
    code: &str,
    request_model: Option<&str>,
    req_body: &serde_json::Value,
) -> Response {
    let _ = write_log(
        state,
        trace_id,
        api_key,
        None,
        None,
        request_model,
        proto,
        Some(status.as_u16() as i64),
        Some(code.to_string()),
        0,
        req_body,
        None,
    );
    err_response(status, code, trace_id)
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
        None => {
            return log_failure(
                &state, &trace_id, None, proto, StatusCode::UNAUTHORIZED,
                "invalid_api_key", None, &body,
            )
        }
    };
    let api_key = match auth::authorize(&state.repo, &key) {
        Ok(Ok(k)) => k,
        Ok(Err(AuthError::QuotaExceeded)) => {
            return log_failure(
                &state, &trace_id, None, proto, StatusCode::TOO_MANY_REQUESTS,
                "quota_exceeded", None, &body,
            )
        }
        Ok(Err(AuthError::Disabled)) => {
            return log_failure(
                &state, &trace_id, None, proto, StatusCode::UNAUTHORIZED,
                "api_key_disabled", None, &body,
            )
        }
        Ok(Err(AuthError::Invalid)) => {
            return log_failure(
                &state, &trace_id, None, proto, StatusCode::UNAUTHORIZED,
                "invalid_api_key", None, &body,
            )
        }
        Err(_) => {
            return log_failure(
                &state, &trace_id, None, proto, StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error", None, &body,
            )
        }
    };

    // 2. parse to unified format
    let mut chat: ChatRequest = match proto {
        Protocol::OpenAI => match openai::request_to_chat(&body) {
            Ok(c) => c,
            Err(e) => {
                return log_failure(
                    &state, &trace_id, Some(&api_key), proto, StatusCode::BAD_REQUEST,
                    &e, None, &body,
                )
            }
        },
        Protocol::Anthropic => match anthropic::request_to_chat(&body) {
            Ok(c) => c,
            Err(e) => {
                return log_failure(
                    &state, &trace_id, Some(&api_key), proto, StatusCode::BAD_REQUEST,
                    &e, None, &body,
                )
            }
        },
    };
    let request_model = chat.model.clone();

    // 3. request-side security inspection
    let unified = serde_json::to_value(&chat).unwrap_or_else(|_| body.clone());
    let proto_str = match proto {
        Protocol::OpenAI => "openai",
        Protocol::Anthropic => "anthropic",
    };
    let scan = match security_hook::inspect_request(
        &state, &trace_id, &api_key, proto_str, &request_model, &unified,
    )
    .await
    {
        RequestVerdict::Blocked(resp) => return resp,
        RequestVerdict::Proceed { body: scanned_unified, scan } => {
            if scan.sanitized {
                match serde_json::from_value::<ChatRequest>(scanned_unified) {
                    Ok(c) => chat = c,
                    Err(_) => {
                        let _ = write_log(
                            &state, &trace_id, Some(&api_key), None, None, Some(&request_model),
                            proto, Some(StatusCode::UNPROCESSABLE_ENTITY.as_u16() as i64),
                            Some("redact_reparse_failed".to_string()), 0, &body, Some(&scan),
                        );
                        return err_response(StatusCode::UNPROCESSABLE_ENTITY, "redact_reparse_failed", &trace_id);
                    }
                }
            }
            scan
        }
    };

    // 4. role detection
    let role = {
        let conn = state.db.conn();
        let conn = conn.lock();
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

    if chat.stream {
        return handle_stream(state, &trace_id, &api_key, chat, role_route, role.clone(), proto, &request_model, &unified, &scan, started).await;
    }

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

            let resp_scan = security_hook::inspect_response(&state, &o.body);
            let settings = state.security.read().clone();

            let merged_scan = merge_scan_for_log(&scan, &resp_scan);
            let is_resp_block = resp_scan.action == SecurityAction::Block;
            let log_status = if is_resp_block { Some(451i64) } else { None };
            let log_error = if is_resp_block {
                Some("blocked_by_security".to_string())
            } else {
                None
            };

            match write_log(
                &state, &trace_id, Some(&api_key), Some(o), Some(&role), Some(&request_model),
                proto, log_status, log_error, latency, &body, Some(&merged_scan),
            ) {
                Ok(log_id) => {
                    for f in &scan.findings {
                        if let Err(e) = security_hook::insert_finding(&state.repo, &log_id, "request", f) {
                            log::error!("failed to insert request security finding: {}", e);
                        }
                    }
                    for f in &resp_scan.findings {
                        if let Err(e) = security_hook::insert_finding(&state.repo, &log_id, "response", f) {
                            log::error!("failed to insert response security finding: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::error!("failed to insert request log: {}", e);
                }
            }

            match resp_scan.action {
                SecurityAction::Block => {
                    (
                        StatusCode::from_u16(451).unwrap(),
                        Json(json!({
                            "error": {
                                "code": "blocked_by_security",
                                "trace_id": trace_id,
                                "summary": format!("响应侧：{}", resp_scan.summary)
                            }
                        })),
                    ).into_response()
                }
                SecurityAction::Redact => {
                    let redacted = crate::security::redact::redact_json(&o.body, &settings);
                    let redacted_outcome = forwarder::Outcome {
                        body: redacted,
                        ..o.clone()
                    };
                    let resp_body = match proto {
                        Protocol::OpenAI => {
                            openai::chat_to_response(&to_chat_response(&redacted_outcome, &request_model))
                        }
                        Protocol::Anthropic => {
                            anthropic::chat_to_response(&to_chat_response(&redacted_outcome, &request_model))
                        }
                    };
                    (StatusCode::OK, Json(resp_body)).into_response()
                }
                _ => {
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
            }
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
            let _ = write_log(
                &state, &trace_id, Some(&api_key), None, Some(&role), Some(&request_model),
                proto, Some(status.as_u16() as i64), Some(e.to_string()), latency, &body, Some(&scan),
            );
            err_response(status, code, &trace_id)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_stream(
    state: AppState,
    trace_id: &str,
    api_key: &crate::db::models::ApiKey,
    chat: ChatRequest,
    role_route: Option<(String, String)>,
    role: Option<String>,
    proto: Protocol,
    request_model: &str,
    req_body: &serde_json::Value,
    scan: &SecurityScanResult,
    started: std::time::Instant,
) -> Response {
    match forwarder::forward_stream(&state, &chat, role_route).await {
        Ok(handle) => {
            let channel = handle.channel.clone();
            let model = handle.model.clone();
            let via_fallback = handle.via_fallback;
            let usage_protocol = handle.usage_protocol;
            let state2 = state.clone();
            let trace = trace_id.to_string();
            let api_key2 = api_key.clone();
            let req_model = request_model.to_string();
            let req_body_masked = crate::security::redact::redact_json_for_logging(req_body).to_string();

            let acc = Arc::new(std::sync::Mutex::new(
                crate::proxy::sse::SseAccumulator::new(usage_protocol),
            ));
            let acc_log = acc.clone();
            let stream_error = Arc::new(AtomicBool::new(false));
            let stream_error_log = stream_error.clone();

            let mut buffer: Vec<u8> = Vec::new();
            let stream = handle.byte_stream.map(move |chunk| {
                match chunk {
                    Ok(bytes) => {
                        buffer.extend_from_slice(&bytes);
                        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                            let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
                            let line = String::from_utf8_lossy(&line_bytes);
                            acc.lock().unwrap().feed_line(&line);
                        }
                        Ok(bytes)
                    }
                    Err(_e) => {
                        stream_error.store(true, Ordering::SeqCst);
                        Ok::<_, std::io::Error>(bytes::Bytes::new())
                    }
                }
            });

            let req_scan = scan.clone();
            let wrapped = stream.chain(futures::stream::once(async move {
                let usage = acc_log.lock().unwrap().usage();
                let text = acc_log.lock().unwrap().text().to_string();
                let failed = stream_error_log.load(Ordering::SeqCst);
                let (status_code, error) = if failed {
                    (Some(502), Some("upstream_stream_error".into()))
                } else {
                    let _ = state2
                        .repo
                        .consume_quota(&api_key2.id, (usage.input_tokens + usage.output_tokens) as i64);
                    (Some(200), None)
                };

                let resp_body = serde_json::json!({"content": text});
                let resp_scan = security_hook::inspect_response(&state2, &resp_body);
                let merged_scan = merge_scan_for_log(&req_scan, &resp_scan);
                let (risk_level, risk_score, risk_summary, security_action, sanitized, blocked_reason) = (
                    serde_json::to_string(&merged_scan.risk_level).unwrap().trim_matches('"').to_string(),
                    merged_scan.risk_score,
                    Some(merged_scan.summary.clone()),
                    merged_scan.action.as_str().to_string(),
                    merged_scan.sanitized,
                    merged_scan.blocked_reason.clone(),
                );

                let log_id = uuid::Uuid::new_v4().to_string();
                if let Err(e) = state2.repo.insert_log(&RequestLog {
                    id: log_id.clone(),
                    seq: 0,
                    trace_id: trace,
                    api_key_id: Some(api_key2.id.clone()),
                    key_name: Some(api_key2.name.clone()),
                    channel_id: Some(channel.id.clone()),
                    channel_name: Some(channel.name.clone()),
                    role,
                    request_model: Some(req_model),
                    upstream_model: Some(model),
                    protocol: match proto {
                        Protocol::OpenAI => "openai".into(),
                        Protocol::Anthropic => "anthropic".into(),
                    },
                    status_code,
                    input_tokens: usage.input_tokens as i64,
                    output_tokens: usage.output_tokens as i64,
                    latency_ms: started.elapsed().as_millis() as i64,
                    is_stream: true,
                    error,
                    fallback: via_fallback,
                    tool_calls: None,
                    request_body: Some(req_body_masked),
                    response_body: None,
                    risk_level,
                    risk_score,
                    risk_summary,
                    security_action,
                    sanitized,
                    blocked_reason,
                    created_at: chrono::Utc::now().timestamp(),
                }) {
                    log::error!("failed to insert stream request log: {}", e);
                }

                for f in &req_scan.findings {
                    if let Err(e) = security_hook::insert_finding(&state2.repo, &log_id, "request", f) {
                        log::error!("failed to insert request security finding: {}", e);
                    }
                }

                for f in &resp_scan.findings {
                    if let Err(e) = security_hook::insert_finding(&state2.repo, &log_id, "response", f) {
                        log::error!("failed to insert response security finding: {}", e);
                    }
                }

                Ok(bytes::Bytes::new())
            }));

            Response::builder()
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache")
                .body(Body::from_stream(wrapped))
                .unwrap()
        }
        Err(e) => {
            let (status, code) = match &e {
                ForwardError::NoChannel => (StatusCode::SERVICE_UNAVAILABLE, "no_available_channel"),
                ForwardError::Upstream { status, .. } => (
                    StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY),
                    "upstream_error",
                ),
                ForwardError::Http(_) => (StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            };
            let latency = started.elapsed().as_millis() as i64;
            let (risk_level, risk_score, risk_summary, security_action, sanitized, blocked_reason) = (
                serde_json::to_string(&scan.risk_level).unwrap().trim_matches('"').to_string(),
                scan.risk_score,
                Some(scan.summary.clone()),
                scan.action.as_str().to_string(),
                scan.sanitized,
                scan.blocked_reason.clone(),
            );
            let _ = state.repo.insert_log(&RequestLog {
                id: uuid::Uuid::new_v4().to_string(),
                seq: 0,
                trace_id: trace_id.to_string(),
                api_key_id: Some(api_key.id.clone()),
                key_name: Some(api_key.name.clone()),
                channel_id: None,
                channel_name: None,
                role,
                request_model: Some(request_model.to_string()),
                upstream_model: None,
                protocol: match proto {
                    Protocol::OpenAI => "openai".into(),
                    Protocol::Anthropic => "anthropic".into(),
                },
                status_code: Some(status.as_u16() as i64),
                input_tokens: 0,
                output_tokens: 0,
                latency_ms: latency,
                is_stream: true,
                error: Some(e.to_string()),
                fallback: false,
                tool_calls: None,
                request_body: Some(crate::security::redact::redact_json_for_logging(req_body).to_string()),
                response_body: None,
                risk_level,
                risk_score,
                risk_summary,
                security_action,
                sanitized,
                blocked_reason,
                created_at: chrono::Utc::now().timestamp(),
            });
            err_response(status, code, trace_id)
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

fn merge_scan_for_log(req: &SecurityScanResult, resp: &SecurityScanResult) -> SecurityScanResult {
    fn action_rank(a: &SecurityAction) -> u8 {
        match a {
            SecurityAction::Allow => 0,
            SecurityAction::Warn => 1,
            SecurityAction::Redact => 2,
            SecurityAction::Block => 3,
        }
    }

    let mut merged = SecurityScanResult::default();
    merged.risk_level = if resp.risk_level.rank() > req.risk_level.rank() {
        resp.risk_level.clone()
    } else {
        req.risk_level.clone()
    };
    merged.risk_score = resp.risk_score.max(req.risk_score);
    merged.action = if action_rank(&resp.action) > action_rank(&req.action) {
        resp.action.clone()
    } else {
        req.action.clone()
    };
    merged.sanitized = req.sanitized;
    merged.blocked_reason = if merged.action == SecurityAction::Block {
        if resp.action == SecurityAction::Block {
            resp.blocked_reason.clone()
        } else {
            req.blocked_reason.clone()
        }
    } else {
        None
    };
    merged.summary = if resp.risk_level.rank() > req.risk_level.rank() {
        resp.summary.clone()
    } else {
        req.summary.clone()
    };
    merged
}

#[allow(clippy::too_many_arguments)]
fn write_log(
    state: &AppState,
    trace_id: &str,
    api_key: Option<&crate::db::models::ApiKey>,
    o: Option<&forwarder::Outcome>,
    role: Option<&Option<String>>,
    request_model: Option<&str>,
    proto: Protocol,
    status_code: Option<i64>,
    error: Option<String>,
    latency: i64,
    req_body: &serde_json::Value,
    scan: Option<&SecurityScanResult>,
) -> crate::error::AppResult<String> {
    let (risk_level, risk_score, risk_summary, security_action, sanitized, blocked_reason) =
        match scan {
            Some(s) => (
                serde_json::to_string(&s.risk_level).unwrap().trim_matches('"').to_string(),
                s.risk_score,
                Some(s.summary.clone()),
                s.action.as_str().to_string(),
                s.sanitized,
                s.blocked_reason.clone(),
            ),
            None => (
                "clean".to_string(),
                0,
                None,
                "allow".to_string(),
                false,
                None,
            ),
        };
    let log_id = uuid::Uuid::new_v4().to_string();
    let log = RequestLog {
        id: log_id.clone(),
        seq: 0,
        trace_id: trace_id.to_string(),
        api_key_id: api_key.map(|k| k.id.clone()),
        key_name: api_key.map(|k| k.name.clone()),
        channel_id: o.map(|x| x.channel.id.clone()),
        channel_name: o.map(|x| x.channel.name.clone()),
        role: role.cloned().flatten(),
        request_model: request_model.map(|s| s.to_string()),
        upstream_model: o.map(|x| x.model.clone()),
        protocol: match proto {
            Protocol::OpenAI => "openai".into(),
            Protocol::Anthropic => "anthropic".into(),
        },
        status_code: status_code.or_else(|| o.map(|x| x.status as i64)),
        input_tokens: o.map(|x| x.usage.input_tokens as i64).unwrap_or(0),
        output_tokens: o.map(|x| x.usage.output_tokens as i64).unwrap_or(0),
        latency_ms: latency,
        is_stream: false,
        error,
        fallback: o.map(|x| x.via_fallback).unwrap_or(false),
        tool_calls: None,
        request_body: Some(crate::security::redact::redact_json_for_logging(req_body).to_string()),
        response_body: o.map(|x| crate::security::redact::redact_json_for_logging(&x.body).to_string()),
        risk_level,
        risk_score,
        risk_summary,
        security_action,
        sanitized,
        blocked_reason,
        created_at: chrono::Utc::now().timestamp(),
    };
    state.repo.insert_log(&log)?;
    Ok(log_id)
}
