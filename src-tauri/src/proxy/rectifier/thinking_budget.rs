//! 处理 Anthropic thinking budget 约束错误：判定 + budget 整流。

use super::RectifierConfig;

pub fn should_rectify_thinking_budget(error_message: &str, cfg: &RectifierConfig) -> bool {
    if !cfg.enabled || !cfg.request_thinking_budget {
        return false;
    }
    let m = error_message.to_lowercase();
    m.contains("budget") && (m.contains("thinking") || m.contains("max_tokens"))
}

/// 修改 body 的 thinking.budget_tokens：若存在则移除 budget_tokens（改为 enabled 无 budget）。
/// 返回是否有变化。
pub fn rectify_thinking_budget(body: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(thinking) = body.get_mut("thinking").and_then(|t| t.as_object_mut()) {
        if thinking.contains_key("budget_tokens") {
            thinking.remove("budget_tokens");
            changed = true;
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
    fn matches_budget_and_thinking_error() {
        assert!(should_rectify_thinking_budget(
            "max_tokens exceeds thinking budget_tokens limit",
            &cfg()
        ));
    }

    #[test]
    fn matches_budget_without_thinking_word() {
        assert!(should_rectify_thinking_budget(
            "budget_tokens must be at least 1024 with max_tokens",
            &cfg()
        ));
    }

    #[test]
    fn does_not_match_unrelated_error() {
        assert!(!should_rectify_thinking_budget(
            "rate limit exceeded, retry later",
            &cfg()
        ));
    }

    #[test]
    fn disabled_by_flag() {
        let c = RectifierConfig {
            request_thinking_budget: false,
            ..RectifierConfig::default()
        };
        assert!(!should_rectify_thinking_budget(
            "thinking budget_tokens error",
            &c
        ));
    }

    #[test]
    fn removes_budget_tokens_and_reports_change() {
        let mut body = serde_json::json!({
            "thinking": {"type": "enabled", "budget_tokens": 4096}
        });
        assert!(rectify_thinking_budget(&mut body));
        assert_eq!(
            body,
            serde_json::json!({"thinking": {"type": "enabled"}})
        );
    }

    #[test]
    fn no_thinking_returns_false() {
        let mut body = serde_json::json!({
            "messages": [{"role": "user", "content": "hi"}]
        });
        assert!(!rectify_thinking_budget(&mut body));
    }

    #[test]
    fn thinking_without_budget_returns_false() {
        let mut body = serde_json::json!({
            "thinking": {"type": "disabled"}
        });
        assert!(!rectify_thinking_budget(&mut body));
        // 结构保持不变
        assert_eq!(body, serde_json::json!({"thinking": {"type": "disabled"}}));
    }
}
