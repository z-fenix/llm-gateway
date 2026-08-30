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

/// 是否应把「模型不支持图像」错误重路由到 image 角色：仅当当前角色非 image、
/// 该错误非 failover 状态、且错误体命中图像不支持措辞时。
fn should_reroute_to_image(role: &Option<String>, status: u16, body: &str) -> bool {
    role.as_deref() != Some("image")
        && !is_failover_status(status)
        && crate::proxy::rectifier::media::is_image_unsupported_error(body)
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
                // 4xx 非 failover：直接返回，不继续；但「模型不支持图像」错误可改为 image 角色重试一次
                let is_4xx_non_failover = match &e {
                    ForwardError::Upstream { status, .. } => !is_failover_status(*status),
                    _ => false,
                };
                if is_4xx_non_failover {
                    let want_image_reroute = role.as_deref() != Some("image")
                        && match &e {
                            ForwardError::Upstream { body, .. } => {
                                crate::proxy::rectifier::media::is_image_unsupported_error(body)
                            }
                            _ => false,
                        };
                    if want_image_reroute {
                        let img_cands =
                            build_candidates(state, &all, &Some("image".into()), &chat.model);
                        for (ich, imodel, ifb, irid) in img_cands {
                            let istart = std::time::Instant::now();
                            if let Ok((status, body, usage)) =
                                try_channel(state, &ich, &imodel, chat).await
                            {
                                let latency = istart.elapsed().as_millis() as i64;
                                if let Some(rid) = &irid {
                                    breaker_record_success(state, rid);
                                }
                                let _ = state.repo.record_channel_stats(
                                    &ich.id,
                                    (usage.input_tokens + usage.output_tokens) as i64,
                                    latency,
                                    true,
                                );
                                return Ok(ForwardResult {
                                    outcome: Outcome {
                                        status,
                                        body,
                                        usage,
                                        channel: ich,
                                        model: imodel,
                                        via_fallback: ifb,
                                        latency_ms: latency,
                                    },
                                    role: Some("image".into()),
                                });
                            }
                        }
                    }
                    return Err(e);
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
                // 某些上游在流式请求失败时返回 HTTP 200 + application/json 错误 body，
                // 直接透传会导致客户端收到空 SSE。这里通过 content-type 识别并提前报错。
                let content_type = r
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_lowercase();
                if !content_type.contains("text/event-stream") {
                    let status = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    if let Some(err) = detect_upstream_error(&text) {
                        if let Some(rid) = &route_id {
                            breaker_record_failure(state, rid);
                        }
                        return Err(ForwardError::Upstream {
                            status: if status == 200 { 400 } else { status },
                            body: serde_json::json!({"error": err}).to_string(),
                        });
                    }
                    // 非 SSE 且不是错误：当成单块流回传（上游协议违规，但比空流好）。
                    let bytes = bytes::Bytes::from(text.into_bytes());
                    let stream =
                        futures::stream::once(async move { Ok::<_, reqwest::Error>(bytes) });
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
                        byte_stream: Box::pin(stream),
                    });
                }
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
                // 图像不支持错误：改用 image 角色流式重试一次（防御性兜底）
                let body_ref = match &e {
                    ForwardError::Upstream { body, .. } => body.as_str(),
                    _ => "",
                };
                if should_reroute_to_image(&role, status, body_ref) {
                    let img_cands =
                        build_candidates(state, &all, &Some("image".into()), &chat.model);
                    for (ich, imodel, ifb, irid) in img_cands {
                        let istart = std::time::Instant::now();
                        let iurl = upstream_url(
                            &ich.upstream_protocol,
                            &ich.base_url,
                            &imodel,
                            &ich.api_key,
                            true,
                        );
                        let mut ibody = build_upstream_body(chat, &ich.upstream_protocol, &imodel);
                        ibody["stream"] = serde_json::json!(true);
                        let mut ireq = state
                            .http
                            .post(&iurl)
                            .header("content-type", "application/json")
                            .timeout(std::time::Duration::from_secs(ich.timeout_secs as u64));
                        if let Some((hname, hval)) =
                            auth_header(&ich.upstream_protocol, &ich.api_key)
                        {
                            ireq = ireq.header(hname, hval);
                        }
                        match ireq.json(&ibody).send().await {
                            Ok(r) if r.status().is_success() => {
                                let latency = istart.elapsed().as_millis() as i64;
                                let content_type = r
                                    .headers()
                                    .get("content-type")
                                    .and_then(|v| v.to_str().ok())
                                    .unwrap_or("")
                                    .to_lowercase();
                                if !content_type.contains("text/event-stream") {
                                    let status = r.status().as_u16();
                                    let text = r.text().await.unwrap_or_default();
                                    if let Some(err) = detect_upstream_error(&text) {
                                        if let Some(rid) = &irid {
                                            breaker_record_failure(state, rid);
                                        }
                                        return Err(ForwardError::Upstream {
                                            status: if status == 200 { 400 } else { status },
                                            body: serde_json::json!({"error": err}).to_string(),
                                        });
                                    }
                                    let bytes = bytes::Bytes::from(text.into_bytes());
                                    let stream = futures::stream::once(async move {
                                        Ok::<_, reqwest::Error>(bytes)
                                    });
                                    if let Some(rid) = &irid {
                                        breaker_record_success(state, rid);
                                    }
                                    let _ =
                                        state.repo.record_channel_stats(&ich.id, 0, latency, true);
                                    let usage_protocol = match ich.upstream_protocol.as_str() {
                                        "anthropic-messages" => {
                                            crate::proxy::sse::Protocol::Anthropic
                                        }
                                        "gemini-native" => crate::proxy::sse::Protocol::Gemini,
                                        "openai-responses" => {
                                            crate::proxy::sse::Protocol::Responses
                                        }
                                        _ => crate::proxy::sse::Protocol::OpenAI,
                                    };
                                    return Ok(StreamHandle {
                                        channel: ich,
                                        model: imodel,
                                        via_fallback: ifb,
                                        usage_protocol,
                                        byte_stream: Box::pin(stream),
                                    });
                                }
                                if let Some(rid) = &irid {
                                    breaker_record_success(state, rid);
                                }
                                let _ = state.repo.record_channel_stats(&ich.id, 0, latency, true);
                                let usage_protocol = match ich.upstream_protocol.as_str() {
                                    "anthropic-messages" => crate::proxy::sse::Protocol::Anthropic,
                                    "gemini-native" => crate::proxy::sse::Protocol::Gemini,
                                    "openai-responses" => crate::proxy::sse::Protocol::Responses,
                                    _ => crate::proxy::sse::Protocol::OpenAI,
                                };
                                return Ok(StreamHandle {
                                    channel: ich,
                                    model: imodel,
                                    via_fallback: ifb,
                                    usage_protocol,
                                    byte_stream: Box::pin(r.bytes_stream()),
                                });
                            }
                            _ => {}
                        }
                    }
                }
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

/// 检测上游响应 body 是否是一个错误对象（OpenAI/Anthropic 风格）。
/// 某些上游会返回 HTTP 200 + error body，导致网关把它当成成功响应并生成 content 为 null 的 Message。
fn detect_upstream_error(text: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(err) = v.get("error") {
        if !err.is_null() {
            return Some(err.clone());
        }
    }
    if v.get("type").and_then(|t| t.as_str()) == Some("error") {
        return Some(v.get("error").cloned().unwrap_or_else(|| v.clone()));
    }
    None
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
    // 某些上游会返回 HTTP 200 + error body，必须当成错误处理，否则下游会得到 content=null 的 Message。
    // 仅对 200 检测，避免拦截整流重试需要的 4xx 错误体。
    if status == 200 {
        if let Some(err) = detect_upstream_error(&text) {
            return Err(ForwardError::Upstream {
                status: 400,
                body: serde_json::json!({"error": err}).to_string(),
            });
        }
    }
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

    #[test]
    fn should_reroute_to_image_logic() {
        let none = None;
        let some_img = Some("image".to_string());
        let some_s = Some("sonnet".to_string());
        // 非 image 角色 + 非 failover + 图像不支持措辞 → 应重路由
        assert!(should_reroute_to_image(
            &some_s,
            400,
            "model does not support images"
        ));
        // image 角色不再重路由（避免循环）
        assert!(!should_reroute_to_image(
            &some_img,
            400,
            "model does not support images"
        ));
        // failover 状态不截胡
        assert!(!should_reroute_to_image(
            &some_s,
            429,
            "image not supported"
        ));
        assert!(!should_reroute_to_image(
            &some_s,
            503,
            "image not supported"
        ));
        // 无角色（等价 auto）且含图错误 → 重路由
        assert!(should_reroute_to_image(&none, 400, "unsupported image"));
        // 无图像措辞则不重路由
        assert!(!should_reroute_to_image(
            &some_s,
            400,
            "rate limit exceeded"
        ));
    }

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

    #[test]
    fn detect_upstream_error_openai_style() {
        let text = r#"{"error":{"message":"Invalid JSON data","type":"invalid_request_error"}}"#;
        let err = detect_upstream_error(text).unwrap();
        assert_eq!(err["message"], "Invalid JSON data");
    }

    #[test]
    fn detect_upstream_error_anthropic_style() {
        let text =
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad request"}}"#;
        let err = detect_upstream_error(text).unwrap();
        assert_eq!(err["message"], "bad request");
    }

    #[test]
    fn detect_upstream_error_ignores_success_body() {
        let text = r#"{"choices":[{"message":{"content":"hi"}}]}"#;
        assert!(detect_upstream_error(text).is_none());
    }

    #[test]
    fn detect_upstream_error_ignores_non_json() {
        assert!(detect_upstream_error("not json").is_none());
    }
}
