use crate::db::models::{ApiKey, Channel};
use crate::protocol::types::ChatRequest;
use crate::provider::adapter::{auth_header, build_upstream_body, upstream_url};
use crate::proxy::sse::Usage;
use crate::proxy::state::AppState;
use bytes::Bytes;
use futures::Stream;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Outcome {
    pub status: u16,
    pub body: serde_json::Value,
    pub usage: Usage,
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
    pub latency_ms: i64,
}

#[derive(Debug)]
pub struct ForwardResult {
    pub outcome: Outcome,
    pub role: Option<String>,
}

pub struct StreamHandle {
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
    pub usage_protocol: crate::proxy::sse::Protocol,
    pub byte_stream: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
}

#[derive(Debug, Error)]
pub enum ForwardError {
    #[error("no_available_channel")]
    NoChannel,
    #[error("upstream_unavailable: status={status} body={body}")]
    Upstream { status: u16, body: String },
    #[error("http: {0}")]
    Http(String),
}

/// 判断该状态码是否触发切换/兜底。
fn is_failover_status(status: u16) -> bool {
    status == 429 || status == 401 || status == 403 || status >= 500
}

/// 编排一次转发。
/// role_route: Some((channel_id, target_model)) 表示已识别角色并有绑定。
pub async fn forward(
    state: &AppState,
    chat: &ChatRequest,
    role_route: Option<(String, String)>,
    _api_key: &ApiKey,
) -> Result<ForwardResult, ForwardError> {
    // 组装候选序列
    let all = state
        .repo
        .list_channels()
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let by_id = |id: &str| all.iter().find(|c| c.id == id).cloned();

    let mut candidates: Vec<(Channel, String, bool)> = Vec::new(); // (channel, model, via_fallback)
    if let Some((cid, model)) = &role_route {
        if let Some(ch) = by_id(cid) {
            candidates.push((ch, model.clone(), false));
        }
        if let Some((fid, fmodel)) = state.fallback.read().clone() {
            if let Some(fch) = by_id(&fid) {
                candidates.push((fch, fmodel, true));
            }
        }
    } else {
        // 普通调度：复用 dispatch 排序
        let maps_fn = |c: &Channel, m: &str| {
            let maps = state.repo.get_model_map(&c.id).unwrap_or_default();
            crate::router::model_map::resolve_model(&maps, m)
        };
        let plan = crate::router::dispatch::plan_route(None, None, &all, &maps_fn, &chat.model, 1);
        for t in plan {
            candidates.push((t.channel, t.model, t.via_fallback));
        }
    }

    if candidates.is_empty() {
        return Err(ForwardError::NoChannel);
    }

    let max = if role_route.is_some() {
        candidates.len()
    } else {
        (state.retry_count + 1).min(candidates.len())
    };
    let mut last_err: Option<ForwardError> = None;
    for (ch, model, via_fallback) in candidates.into_iter().take(max) {
        let start = std::time::Instant::now();
        match try_channel(state, &ch, &model, chat).await {
            Ok((status, body, usage)) => {
                let latency = start.elapsed().as_millis() as i64;
                if let Err(e) = state.repo.record_channel_stats(
                    &ch.id,
                    (usage.input_tokens + usage.output_tokens) as i64,
                    latency,
                    true,
                ) {
                    log::error!("failed to record channel stats: {}", e);
                }
                return Ok(ForwardResult {
                    outcome: Outcome {
                        status,
                        body,
                        usage,
                        channel: ch,
                        model,
                        via_fallback,
                        latency_ms: latency,
                    },
                    role: None,
                });
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as i64;
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, false) {
                    log::error!("failed to record channel stats: {}", e);
                }
                // 4xx 非 failover：直接返回，不继续
                if let ForwardError::Upstream { status, .. } = &e {
                    if !is_failover_status(*status) {
                        return Err(e);
                    }
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or(ForwardError::NoChannel))
}

pub async fn forward_stream(
    state: &AppState,
    chat: &ChatRequest,
    role_route: Option<(String, String)>,
) -> Result<StreamHandle, ForwardError> {
    let all = state
        .repo
        .list_channels()
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let by_id = |id: &str| all.iter().find(|c| c.id == id).cloned();
    let mut candidates: Vec<(Channel, String, bool)> = Vec::new();
    if let Some((cid, model)) = &role_route {
        if let Some(ch) = by_id(cid) {
            candidates.push((ch, model.clone(), false));
        }
        if let Some((fid, fmodel)) = state.fallback.read().clone() {
            if let Some(fch) = by_id(&fid) {
                candidates.push((fch, fmodel, true));
            }
        }
    } else {
        let maps_fn = |c: &Channel, m: &str| {
            let maps = state.repo.get_model_map(&c.id).unwrap_or_default();
            crate::router::model_map::resolve_model(&maps, m)
        };
        for t in crate::router::dispatch::plan_route(None, None, &all, &maps_fn, &chat.model, 1) {
            candidates.push((t.channel, t.model, t.via_fallback));
        }
    }
    if candidates.is_empty() {
        return Err(ForwardError::NoChannel);
    }

    let max = if role_route.is_some() {
        candidates.len()
    } else {
        (state.retry_count + 1).min(candidates.len())
    };
    let mut last_err = None;
    for (ch, model, via_fallback) in candidates.into_iter().take(max) {
        let start = std::time::Instant::now();
        let url = upstream_url(
            &ch.upstream_protocol,
            &ch.base_url,
            &model,
            &ch.api_key,
            true,
        );
        let mut body = build_upstream_body(chat, &ch.upstream_protocol, &model);
        body["stream"] = serde_json::json!(true);
        let mut req = state
            .http
            .post(&url)
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
        if let Some((hname, hval)) = auth_header(&ch.upstream_protocol, &ch.api_key) {
            req = req.header(hname, hval);
        }
        let resp = req.json(&body).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let latency = start.elapsed().as_millis() as i64;
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, true) {
                    log::error!("failed to record channel stats: {}", e);
                }
                let usage_protocol = match ch.upstream_protocol.as_str() {
                    "anthropic-messages" => crate::proxy::sse::Protocol::Anthropic,
                    "gemini-native" => crate::proxy::sse::Protocol::Gemini,
                    _ => crate::proxy::sse::Protocol::OpenAI,
                };
                return Ok(StreamHandle {
                    channel: ch,
                    model,
                    via_fallback,
                    usage_protocol,
                    byte_stream: Box::pin(r.bytes_stream()),
                });
            }
            Ok(r) => {
                let latency = start.elapsed().as_millis() as i64;
                let status = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, false) {
                    log::error!("failed to record channel stats: {}", e);
                }
                let e = ForwardError::Upstream { status, body: text };
                if !is_failover_status(status) {
                    return Err(e);
                }
                last_err = Some(e);
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as i64;
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, false) {
                    log::error!("failed to record channel stats: {}", e);
                }
                last_err = Some(ForwardError::Http(e.to_string()));
            }
        }
    }
    Err(last_err.unwrap_or(ForwardError::NoChannel))
}

async fn try_channel(
    state: &AppState,
    ch: &Channel,
    model: &str,
    chat: &ChatRequest,
) -> Result<(u16, serde_json::Value, Usage), ForwardError> {
    let url = upstream_url(
        &ch.upstream_protocol,
        &ch.base_url,
        model,
        &ch.api_key,
        chat.stream,
    );
    let body = build_upstream_body(chat, &ch.upstream_protocol, model);
    let mut req = state
        .http
        .post(&url)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
    if let Some((hname, hval)) = auth_header(&ch.upstream_protocol, &ch.api_key) {
        req = req.header(hname, hval);
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    if status != 200 {
        return Err(ForwardError::Upstream { status, body: text });
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::json!({"raw": text}));
    // 非流式：按 upstream_protocol 从 body 提取 usage
    let usage = match ch.upstream_protocol.as_str() {
        "anthropic-messages" => {
            let u = v.get("usage").cloned().unwrap_or(serde_json::json!({}));
            let mut us = Usage::default();
            us.input_tokens = u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            us.output_tokens = u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            us
        }
        "gemini-native" => {
            let u = v
                .get("usageMetadata")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let mut us = Usage::default();
            us.input_tokens = u
                .get("promptTokenCount")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            us.output_tokens = u
                .get("candidatesTokenCount")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            us
        }
        _ => crate::proxy::sse::extract_openai_usage(&v).unwrap_or_default(),
    };
    Ok((status, v, usage))
}
