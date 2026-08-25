use crate::db::models::{ApiKey, Channel};
use crate::protocol::types::ChatRequest;
use crate::provider::adapter::{auth_header, build_upstream_body, upstream_url};
use crate::proxy::sse::Usage;
use crate::proxy::state::AppState;
use crate::router::breaker::Breaker;
use crate::router::dispatch::{order_by_priority_weight, plan_route, RoleCandidate};
use bytes::Bytes;
use futures::Stream;
use std::collections::HashMap;
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

fn breaker_record_success(state: &AppState, route_id: &str) {
    if let Some(b) = state.circuit_breakers.write().get_mut(route_id) {
        b.record_success();
    }
}

fn breaker_record_failure(state: &AppState, route_id: &str) {
    if let Some(b) = state.circuit_breakers.write().get_mut(route_id) {
        b.record_failure();
    }
}

/// 组装一次请求的候选序列：(channel, model, via_fallback, route_id)。
/// - 角色路由：该角色全部启用路由按 priority 分组、组内按 weight 加权随机排序，
///   熔断器不放行的路由被跳过，末尾追加全局兜底。
/// - 否则：普通调度（plan_route），route_id 为 None。
fn build_candidates(
    state: &AppState,
    all: &[Channel],
    role: &Option<String>,
    request_model: &str,
) -> Vec<(Channel, String, bool, Option<String>)> {
    let by_id = |id: &str| all.iter().find(|c| c.id == id).cloned();
    let maps_fn = |c: &Channel, m: &str| {
        let maps = state.repo.get_model_map(&c.id).unwrap_or_default();
        crate::router::model_map::resolve_model(&maps, m)
    };
    let fallback_pair = state
        .fallback
        .read()
        .clone()
        .and_then(|(fid, fmodel)| by_id(&fid).map(|fch| (fch, fmodel)));

    let mut out: Vec<(Channel, String, bool, Option<String>)> = Vec::new();
    if let Some(role) = role {
        let routes = state.repo.get_role_routes(role).unwrap_or_default();
        if !routes.is_empty() {
            let route_cfg: HashMap<String, (i64, i64)> = routes
                .iter()
                .map(|rr| {
                    (
                        rr.id.clone(),
                        (rr.breaker_max_failures, rr.breaker_cooldown_secs),
                    )
                })
                .collect();
            let role_cands: Vec<RoleCandidate> = routes
                .iter()
                .filter_map(|rr| {
                    by_id(&rr.channel_id).map(|ch| RoleCandidate {
                        route_id: rr.id.clone(),
                        channel: ch,
                        model: rr.target_model.clone(),
                        priority: rr.priority,
                        weight: rr.weight,
                    })
                })
                .collect();
            for rc in order_by_priority_weight(
                role_cands,
                |rc| rc.priority,
                |rc| rc.weight.max(0) as u64,
                |rc| rc.route_id.as_str(),
                1,
            ) {
                let (max_failures, cooldown) =
                    route_cfg.get(&rc.route_id).copied().unwrap_or((5, 60));
                let allow = {
                    let mut breakers = state.circuit_breakers.write();
                    breakers
                        .entry(rc.route_id.clone())
                        .or_insert_with(|| Breaker::new(max_failures, cooldown))
                        .allow()
                };
                if allow {
                    out.push((rc.channel, rc.model, false, Some(rc.route_id)));
                }
            }
            if let Some((fch, fmodel)) = fallback_pair {
                out.push((fch, fmodel, true, None));
            }
            return out;
        }
    }
    // 普通调度
    for t in plan_route(&[], fallback_pair, all, &maps_fn, request_model, 1) {
        out.push((t.channel, t.model, t.via_fallback, None));
    }
    out
}

/// 编排一次转发。
/// role: Some(role) 表示已识别角色，走该角色的多供应商路由（含熔断）。
pub async fn forward(
    state: &AppState,
    chat: &ChatRequest,
    role: Option<String>,
    _api_key: &ApiKey,
) -> Result<ForwardResult, ForwardError> {
    let all = state
        .repo
        .list_channels()
        .map_err(|e| ForwardError::Http(e.to_string()))?;

    let candidates = build_candidates(state, &all, &role, &chat.model);
    if candidates.is_empty() {
        return Err(ForwardError::NoChannel);
    }

    let max = if role.is_some() {
        candidates.len()
    } else {
        (state.retry_count + 1).min(candidates.len())
    };
    let mut last_err: Option<ForwardError> = None;
    for (ch, model, via_fallback, route_id) in candidates.into_iter().take(max) {
        let start = std::time::Instant::now();
        match try_channel(state, &ch, &model, chat).await {
            Ok((status, body, usage)) => {
                let latency = start.elapsed().as_millis() as i64;
                if let Some(rid) = &route_id {
                    breaker_record_success(state, rid);
                }
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
                    role,
                });
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as i64;
                if let Some(rid) = &route_id {
                    breaker_record_failure(state, rid);
                }
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
    role: Option<String>,
) -> Result<StreamHandle, ForwardError> {
    let all = state
        .repo
        .list_channels()
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let candidates = build_candidates(state, &all, &role, &chat.model);
    if candidates.is_empty() {
        return Err(ForwardError::NoChannel);
    }

    let max = if role.is_some() {
        candidates.len()
    } else {
        (state.retry_count + 1).min(candidates.len())
    };
    let mut last_err = None;
    for (ch, model, via_fallback, route_id) in candidates.into_iter().take(max) {
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
                if let Some(rid) = &route_id {
                    breaker_record_success(state, rid);
                }
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, true) {
                    log::error!("failed to record channel stats: {}", e);
                }
                let usage_protocol = match ch.upstream_protocol.as_str() {
                    "anthropic-messages" => crate::proxy::sse::Protocol::Anthropic,
                    "gemini-native" => crate::proxy::sse::Protocol::Gemini,
                    "openai-responses" => crate::proxy::sse::Protocol::Responses,
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
                if let Some(rid) = &route_id {
                    breaker_record_failure(state, rid);
                }
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
                if let Some(rid) = &route_id {
                    breaker_record_failure(state, rid);
                }
                if let Err(e) = state.repo.record_channel_stats(&ch.id, 0, latency, false) {
                    log::error!("failed to record channel stats: {}", e);
                }
                last_err = Some(ForwardError::Http(e.to_string()));
            }
        }
    }
    Err(last_err.unwrap_or(ForwardError::NoChannel))
}

/// 发送一次上游请求，返回 (status, body_text)。Http 级错误返回 ForwardError::Http。
async fn send_once(
    state: &AppState,
    ch: &Channel,
    url: &str,
    body: &serde_json::Value,
) -> Result<(u16, String), ForwardError> {
    let mut req = state
        .http
        .post(url)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
    if let Some((hname, hval)) = auth_header(&ch.upstream_protocol, &ch.api_key) {
        req = req.header(hname, hval);
    }
    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    Ok((status, text))
}

/// 把上游响应文本解析为 JSON；解析失败时退化为 {"raw": text}。
fn parse_body(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap_or(serde_json::json!({"raw": text}))
}

/// 非流式：按 upstream_protocol 从响应文本提取 usage。
fn extract_usage(ch: &Channel, text: &str) -> Usage {
    let v = parse_body(text);
    match ch.upstream_protocol.as_str() {
        "anthropic-messages" => {
            let u = v.get("usage").cloned().unwrap_or(serde_json::json!({}));
            let mut us = Usage::default();
            us.input_tokens = u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            us.output_tokens = u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
            us.cache_read_tokens = u
                .get("cache_read_input_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            us.cache_creation_tokens = u
                .get("cache_creation_input_tokens")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
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
            // promptTokenCount 含缓存命中；cachedContentTokenCount 为缓存读，无缓存写
            us.cache_read_tokens = u
                .get("cachedContentTokenCount")
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            us
        }
        "openai-responses" => v
            .get("usage")
            .and_then(crate::proxy::sse::extract_responses_usage)
            .unwrap_or_default(),
        _ => crate::proxy::sse::extract_openai_usage(&v).unwrap_or_default(),
    }
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
    let mut body = build_upstream_body(chat, &ch.upstream_protocol, model);
    let cfg = state.rectifier.read().clone();

    // 发送前媒体降级（仅 Anthropic 上游）
    if ch.upstream_protocol == "anthropic-messages" {
        crate::proxy::rectifier::media::apply_media_prevention(&mut body, model, &cfg);
    }

    let (status, text) = send_once(state, ch, &url, &body).await?;
    if status != 200 {
        // 整流重试（仅 Anthropic 上游）：signature 优先，否则 budget；合计最多一次
        if ch.upstream_protocol == "anthropic-messages" {
            let before = body.clone();
            if crate::proxy::rectifier::thinking_signature::should_rectify_thinking_signature(
                &text, &cfg,
            ) {
                crate::proxy::rectifier::thinking_signature::rectify_anthropic_request(&mut body);
            } else if crate::proxy::rectifier::thinking_budget::should_rectify_thinking_budget(
                &text, &cfg,
            ) {
                crate::proxy::rectifier::thinking_budget::rectify_thinking_budget(&mut body);
            }
            if body != before {
                let (status2, text2) = send_once(state, ch, &url, &body).await?;
                if status2 == 200 {
                    return Ok((status2, parse_body(&text2), extract_usage(ch, &text2)));
                }
                // 重试仍失败：返回原始错误，继续 failover
                return Err(ForwardError::Upstream { status, body: text });
            }
        }
        return Err(ForwardError::Upstream { status, body: text });
    }
    Ok((status, parse_body(&text), extract_usage(ch, &text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Channel;

    fn ch(protocol: &str) -> Channel {
        Channel {
            id: "c1".into(),
            name: "c1".into(),
            supplier: "openai".into(),
            upstream_protocol: protocol.into(),
            base_url: "http://localhost".into(),
            api_key: "sk-x".into(),
            models: vec![],
            priority: 0,
            weight: 1,
            enabled: true,
            timeout_secs: 5,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn extract_usage_openai_chat_preserves_existing_behavior() {
        let text = r#"{"choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3}}}"#;
        let u = extract_usage(&ch("openai-chat"), text);
        assert_eq!(u.input_tokens, 10);
        assert_eq!(u.output_tokens, 5);
        assert_eq!(u.cache_read_tokens, 3);
    }

    #[test]
    fn extract_usage_openai_responses_parses_input_output_cached() {
        let text = r#"{"id":"resp_x","object":"response","usage":{"input_tokens":100,"output_tokens":40,"input_tokens_details":{"cached_tokens":60},"total_tokens":140}}"#;
        let u = extract_usage(&ch("openai-responses"), text);
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 40);
        assert_eq!(u.cache_read_tokens, 60);
        assert_eq!(u.cache_creation_tokens, 0);
    }

    #[test]
    fn extract_usage_openai_responses_cache_write() {
        let text = r#"{"usage":{"input_tokens":80,"output_tokens":20,"input_tokens_details":{"cached_tokens":10,"cache_write_tokens":15}}}"#;
        let u = extract_usage(&ch("openai-responses"), text);
        assert_eq!(u.input_tokens, 80);
        assert_eq!(u.output_tokens, 20);
        assert_eq!(u.cache_read_tokens, 10);
        assert_eq!(u.cache_creation_tokens, 15);
    }
}
