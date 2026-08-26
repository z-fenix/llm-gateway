//! 图片降级：发送前对纯文本模型把 image block 替换为 [Unsupported Image]。

use super::RectifierConfig;

/// 内置纯文本模型注册表（无视觉能力的模型）。
pub fn is_text_only_model(model: &str) -> bool {
    let m = model.to_lowercase();
    ["claude-3-haiku", "claude-3-opus", "claude-haiku", "deepseek", "gpt-4o-mini"]
        .iter()
        .any(|s| m.contains(s))
}

/// 判断上游错误体是否表达「模型不支持图像」，用于把它重路由到 `image` 角色。
/// 匹配常见措辞：Anthropic「only supported by …」、OpenAI「does not support images」等。
pub fn is_image_unsupported_error(body: &str) -> bool {
    let b = body.to_lowercase();
    b.contains("image")
        && (b.contains("not support")
            || b.contains("unsupported")
            || b.contains("doesn't support")
            || b.contains("only support"))
}

/// 发送前媒体降级：heuristic 开启且模型为纯文本时，把 image block 替换为文本标记。
/// 返回是否有修改。
pub fn apply_media_prevention(
    body: &mut serde_json::Value,
    model: &str,
    cfg: &RectifierConfig,
) -> bool {
    if !cfg.enabled || !cfg.request_media_fallback || !cfg.request_media_heuristic {
        return false;
    }
    if !is_text_only_model(model) {
        return false;
    }
    let mut changed = false;
    if let Some(msgs) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in msgs {
            if let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                for block in content.iter_mut() {
                    if block.get("type").and_then(|t| t.as_str()) == Some("image") {
                        *block = serde_json::json!({
                            "type": "text",
                            "text": "[Unsupported Image]"
                        });
                        changed = true;
                    }
                }
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RectifierConfig {
        RectifierConfig::default()
    }

    #[test]
    fn is_text_only_model_matches_builtin() {
        assert!(is_text_only_model("claude-3-haiku-20240307"));
        assert!(is_text_only_model("CLAUDE-HAIKU"));
        assert!(is_text_only_model("deepseek-chat"));
        assert!(is_text_only_model("gpt-4o-mini"));
        assert!(is_text_only_model("anthropic.claude-3-opus-20240229"));
    }

    #[test]
    fn is_text_only_model_does_not_match_vision_models() {
        assert!(!is_text_only_model("claude-3-5-sonnet"));
        assert!(!is_text_only_model("claude-sonnet-4-20250514"));
        assert!(!is_text_only_model("gpt-4o"));
    }

    #[test]
    fn replaces_images_for_text_only_model() {
        let mut body = serde_json::json!({
            "model": "claude-3-haiku",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image", "source": {"type": "base64", "data": "x"}}
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "url", "url": "http://a/b.png"}}
                    ]
                }
            ]
        });
        assert!(apply_media_prevention(&mut body, "claude-3-haiku-20240307", &cfg()));
        for msg in body["messages"].as_array().unwrap() {
            for block in msg["content"].as_array().unwrap() {
                assert_eq!(block["type"], "text");
                assert_ne!(block.get("text"), None);
            }
        }
        // 保留的原始 text block 未被触碰
        assert_eq!(body["messages"][0]["content"][0]["text"], "look");
    }

    #[test]
    fn does_not_touch_vision_models() {
        let mut body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "data": "x"}}
                ]}
            ]
        });
        let original = body.clone();
        assert!(!apply_media_prevention(&mut body, "claude-sonnet-4", &cfg()));
        assert_eq!(body, original);
    }

    #[test]
    fn disabled_when_heuristic_off() {
        let c = RectifierConfig {
            request_media_heuristic: false,
            ..RectifierConfig::default()
        };
        let mut body = serde_json::json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "data": "x"}}
                ]}
            ]
        });
        assert!(!apply_media_prevention(&mut body, "claude-3-haiku", &c));
        assert_eq!(body["messages"][0]["content"][0]["type"], "image");
    }

    #[test]
    fn disabled_when_fallback_off() {
        let c = RectifierConfig {
            request_media_fallback: false,
            ..RectifierConfig::default()
        };
        let mut body = serde_json::json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "data": "x"}}
                ]}
            ]
        });
        assert!(!apply_media_prevention(&mut body, "claude-3-haiku", &c));
        assert_eq!(body["messages"][0]["content"][0]["type"], "image");
    }

    #[test]
    fn no_images_returns_false() {
        let mut body = serde_json::json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]}
            ]
        });
        assert!(!apply_media_prevention(&mut body, "claude-3-haiku", &cfg()));
    }

    #[test]
    fn detects_image_unsupported_error() {
        assert!(is_image_unsupported_error("This model does not support images."));
        assert!(is_image_unsupported_error("unsupported image type"));
        assert!(is_image_unsupported_error("images are not supported by this model"));
        assert!(is_image_unsupported_error("Image blocks are only supported by Claude 3 models"));
        assert!(is_image_unsupported_error("image_url is only supported by certain models"));
        assert!(!is_image_unsupported_error("rate limit exceeded"));
        assert!(!is_image_unsupported_error("internal server error"));
    }
}
