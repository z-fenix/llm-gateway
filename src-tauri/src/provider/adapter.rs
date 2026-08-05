use crate::protocol::types::ChatRequest;

/// 统一格式 → 指定渠道类型的上游请求体。
pub fn build_upstream_body(chat: &ChatRequest, provider_type: &str, model: &str) -> serde_json::Value {
    match provider_type {
        "claude" | "anthropic" => crate::protocol::anthropic::chat_request_to_upstream(chat, model),
        // openai / deepseek / gemini(openai-compat) / custom 默认走 OpenAI 格式
        _ => crate::protocol::openai::chat_request_to_upstream(chat, model),
    }
}

/// 上游完整 URL。
pub fn upstream_url(provider_type: &str, base_url: &str, _stream: bool) -> String {
    let base = base_url.trim_end_matches('/');
    match provider_type {
        "claude" | "anthropic" => format!("{}/v1/messages", base),
        "gemini" => format!("{}/v1/chat/completions", base), // gemini openai-compat 端点
        _ => format!("{}/v1/chat/completions", base),
    }
}

/// 上游鉴权头：返回 (header名, 值前缀)。Anthropic 用 x-api-key，其余用 Bearer。
pub fn auth_header(provider_type: &str, api_key: &str) -> (String, String) {
    match provider_type {
        "claude" | "anthropic" => ("x-api-key".to_string(), api_key.to_string()),
        _ => ("authorization".to_string(), format!("Bearer {}", api_key)),
    }
}
