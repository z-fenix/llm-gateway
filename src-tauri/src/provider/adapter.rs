use crate::protocol::types::ChatRequest;

/// 统一格式 → 指定上游协议的上游请求体。
pub fn build_upstream_body(
    chat: &ChatRequest,
    upstream_protocol: &str,
    model: &str,
) -> serde_json::Value {
    match upstream_protocol {
        "anthropic-messages" => crate::protocol::anthropic::chat_request_to_upstream(chat, model),
        "openai-responses" => crate::protocol::responses::chat_request_to_upstream(chat, model),
        "gemini-native" => crate::protocol::gemini::chat_request_to_upstream(chat, model),
        // openai-chat / 自定义渠道默认走 OpenAI Chat Completions 格式
        _ => crate::protocol::openai::chat_request_to_upstream(chat, model),
    }
}

/// 上游完整 URL。
pub fn upstream_url(
    upstream_protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    stream: bool,
) -> String {
    let base = base_url.trim_end_matches('/');
    match upstream_protocol {
        "anthropic-messages" => {
            if base.ends_with("/v1") {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
        "openai-responses" => {
            if base.ends_with("/v1") {
                format!("{}/responses", base)
            } else {
                format!("{}/v1/responses", base)
            }
        }
        "gemini-native" => {
            // Gemini Native: base_url 通常是 https://generativelanguage.googleapis.com/v1beta
            let action = if stream {
                "streamGenerateContent"
            } else {
                "generateContent"
            };
            format!("{}/models/{}:{}?key={}", base, model, action, api_key)
        }
        // openai-chat / 自定义渠道默认走 OpenAI Chat Completions
        _ => {
            if base.ends_with("/v1") {
                format!("{}/chat/completions", base)
            } else {
                format!("{}/v1/chat/completions", base)
            }
        }
    }
}

/// 上游鉴权头。Anthropic 用 x-api-key，OpenAI 系用 Bearer，Gemini Native 的 key 在 URL query 中。
pub fn auth_header(upstream_protocol: &str, api_key: &str) -> Option<(String, String)> {
    match upstream_protocol {
        "anthropic-messages" => Some(("x-api-key".to_string(), api_key.to_string())),
        "gemini-native" => None,
        _ => Some(("authorization".to_string(), format!("Bearer {}", api_key))),
    }
}

#[cfg(test)]
mod tests {
    use super::{auth_header, upstream_url};

    #[test]
    fn openai_chat_url_without_v1_gets_v1_prefix() {
        assert_eq!(
            upstream_url(
                "openai-chat",
                "https://api.openai.com",
                "gpt-4",
                "sk-xxx",
                false
            ),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn openai_chat_url_with_v1_does_not_duplicate() {
        assert_eq!(
            upstream_url(
                "openai-chat",
                "https://api.openai.com/v1",
                "gpt-4",
                "sk-xxx",
                false
            ),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn openai_responses_url_uses_responses_endpoint() {
        assert_eq!(
            upstream_url(
                "openai-responses",
                "https://api.openai.com",
                "gpt-4",
                "sk-xxx",
                false
            ),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn anthropic_messages_url_without_v1_gets_v1_messages() {
        assert_eq!(
            upstream_url(
                "anthropic-messages",
                "https://api.anthropic.com",
                "claude-3",
                "sk-xxx",
                false
            ),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn anthropic_messages_url_with_v1_does_not_duplicate() {
        assert_eq!(
            upstream_url(
                "anthropic-messages",
                "https://api.anthropic.com/v1",
                "claude-3",
                "sk-xxx",
                false
            ),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn gemini_native_url_uses_generate_content_with_key() {
        assert_eq!(
            upstream_url("gemini-native", "https://generativelanguage.googleapis.com/v1beta", "gemini-pro", "AIxxx", false),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=AIxxx"
        );
    }

    #[test]
    fn gemini_native_stream_url_uses_stream_generate_content() {
        assert_eq!(
            upstream_url("gemini-native", "https://generativelanguage.googleapis.com/v1beta", "gemini-pro", "AIxxx", true),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?key=AIxxx"
        );
    }

    #[test]
    fn trailing_slashes_are_normalized() {
        assert_eq!(
            upstream_url(
                "openai-chat",
                "https://api.openai.com/",
                "gpt-4",
                "sk-xxx",
                false
            ),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            upstream_url(
                "openai-chat",
                "https://api.openai.com/v1/",
                "gpt-4",
                "sk-xxx",
                false
            ),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn auth_header_openai_chat_uses_bearer() {
        assert_eq!(
            auth_header("openai-chat", "sk-xxx"),
            Some(("authorization".to_string(), "Bearer sk-xxx".to_string()))
        );
    }

    #[test]
    fn auth_header_openai_responses_uses_bearer() {
        assert_eq!(
            auth_header("openai-responses", "sk-xxx"),
            Some(("authorization".to_string(), "Bearer sk-xxx".to_string()))
        );
    }

    #[test]
    fn auth_header_anthropic_messages_uses_x_api_key() {
        assert_eq!(
            auth_header("anthropic-messages", "sk-xxx"),
            Some(("x-api-key".to_string(), "sk-xxx".to_string()))
        );
    }

    #[test]
    fn auth_header_gemini_native_uses_url_key() {
        assert_eq!(auth_header("gemini-native", "AIxxx"), None);
    }
}
