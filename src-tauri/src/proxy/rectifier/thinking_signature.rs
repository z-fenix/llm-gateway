//! 处理 Anthropic "Invalid 'signature' in 'thinking' block" 类错误：判定 + 请求体整流。

use super::RectifierConfig;

/// 对错误消息做小写子串匹配，命中 signature 相关场景。
pub fn should_rectify_thinking_signature(error_message: &str, cfg: &RectifierConfig) -> bool {
    if !cfg.enabled || !cfg.request_thinking_signature {
        return false;
    }
    let m = error_message.to_lowercase();
    [
        "invalid 'signature' in 'thinking' block".to_string(),
        "signature".to_string() + " in " + "thinking" + " block",
    ]
    .iter()
    .any(|s| m.contains(s))
        || (m.contains("invalid") && m.contains("signature") && m.contains("thinking") && m.contains("block"))
        || m.contains("must start with a thinking block")
        || m.contains("expected")
            && m.contains("found tool_use")
            && m.contains("thinking")
}

/// 原地修改 Anthropic 请求体：删 thinking/redacted_thinking block、去 signature。
pub fn rectify_anthropic_request(body: &mut serde_json::Value) {
    if let Some(msgs) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in msgs {
            if let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                content.retain(|block| {
                    !matches!(
                        block.get("type").and_then(|t| t.as_str()),
                        Some("thinking") | Some("redacted_thinking")
                    )
                });
                for block in content.iter_mut() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("thinking") {
                        if let serde_json::Value::Object(map) = block {
                            map.remove("signature");
                        }
                    }
                }
            }
        }
    }
    // 兜底：删除顶层 thinking 字段
    if let serde_json::Value::Object(map) = body {
        map.remove("thinking");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RectifierConfig {
        RectifierConfig::default()
    }

    #[test]
    fn matches_full_signature_error() {
        assert!(should_rectify_thinking_signature(
            "Invalid 'signature' in 'thinking' block: signature is missing",
            &cfg()
        ));
    }

    #[test]
    fn matches_mixed_case_combination() {
        assert!(should_rectify_thinking_signature(
            "API Error: INVALID Signature in Thinking block detected",
            &cfg()
        ));
    }

    #[test]
    fn matches_must_start_with_thinking_block() {
        assert!(should_rectify_thinking_signature(
            "response must start with a thinking block",
            &cfg()
        ));
    }

    #[test]
    fn does_not_match_unrelated_error() {
        assert!(!should_rectify_thinking_signature(
            "insufficient_quota: your request is over the limit",
            &cfg()
        ));
    }

    #[test]
    fn disabled_by_flag() {
        let c = RectifierConfig {
            request_thinking_signature: false,
            ..RectifierConfig::default()
        };
        assert!(!should_rectify_thinking_signature(
            "Invalid 'signature' in 'thinking' block",
            &c
        ));
    }

    #[test]
    fn disabled_by_enabled_flag() {
        let c = RectifierConfig {
            enabled: false,
            ..RectifierConfig::default()
        };
        assert!(!should_rectify_thinking_signature(
            "Invalid 'signature' in 'thinking' block",
            &c
        ));
    }

    #[test]
    fn removes_thinking_blocks_and_signatures() {
        let mut body = serde_json::json!({
            "model": "claude-sonnet",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "hello"},
                        {"type": "image", "source": {"type": "base64", "data": "x"}}
                    ]
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "secret", "signature": "sig-1"},
                        {"type": "redacted_thinking", "data": "redacted", "signature": "sig-2"},
                        {"type": "text", "text": "answer", "signature": "sig-3"}
                    ]
                }
            ],
            "thinking": {"type": "enabled", "budget_tokens": 1024}
        });
        rectify_anthropic_request(&mut body);
        let blocks = &body["messages"][1]["content"];
        assert_eq!(blocks.as_array().unwrap().len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert!(blocks[0].get("signature").is_none());
        // 保留正常 text 与 image block
        let user_blocks = &body["messages"][0]["content"];
        assert_eq!(user_blocks.as_array().unwrap().len(), 2);
        // 顶层 thinking 字段被删除
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn no_thinking_leaves_body_unchanged_except_top_level() {
        let mut body = serde_json::json!({
            "model": "claude-sonnet",
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello"}]}
            ]
        });
        let original = body.clone();
        rectify_anthropic_request(&mut body);
        assert_eq!(body, original);
    }

    #[test]
    fn strips_signature_from_text_blocks() {
        let mut body = serde_json::json!({
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "text", "text": "hi", "signature": "sig-x"}
                ]}
            ]
        });
        rectify_anthropic_request(&mut body);
        assert!(body["messages"][0]["content"][0].get("signature").is_none());
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
    }
}
