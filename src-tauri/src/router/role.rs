/// 大小写不敏感通配匹配：`*` 匹配任意字符序列（含空）。
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.to_lowercase();
    let t = text.to_lowercase();
    let p: Vec<char> = p.chars().collect();
    let t: Vec<char> = t.chars().collect();
    wildcard_inner(&p, &t)
}

fn wildcard_inner(p: &[char], t: &[char]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    if p[0] == '*' {
        // `*` 匹配 0..=t.len() 个字符
        for skip in 0..=t.len() {
            if wildcard_inner(&p[1..], &t[skip..]) {
                return true;
            }
        }
        return false;
    }
    if t.is_empty() {
        return false;
    }
    if p[0] == t[0] {
        return wildcard_inner(&p[1..], &t[1..]);
    }
    false
}

/// 从 role_patterns 表按 priority 降序找第一条启用且命中 model 的规则，返回其 role。
pub fn detect_role(conn: &rusqlite::Connection, model: &str) -> Option<String> {
    let mut stmt = conn
        .prepare("SELECT pattern, role FROM role_patterns WHERE enabled=1 ORDER BY priority DESC")
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()?;
    for row in rows.flatten() {
        if wildcard_match(&row.0, model) {
            return Some(row.1);
        }
    }
    None
}

/// 判断统一请求是否含图像内容（用于把角色覆盖为 `image`）。
/// `content` 可能为纯文本字符串或数组；数组块可能是 Anthropic 的 `type=="image"`、
/// OpenAI 的 `type=="image_url"`，或含 `image_url` 键（含工具返回 `input_image`）。
/// 注意：Responses/Gemini 入站会把图像块丢弃，故这些协议下检测不到（已知限制）。
pub fn is_image_request(chat: &crate::protocol::types::ChatRequest) -> bool {
    chat.messages.iter().any(|m| {
        let arr = match m.content.as_array() {
            Some(a) => a,
            None => return false,
        };
        arr.iter().any(|b| {
            b.get("type")
                .and_then(|t| t.as_str())
                .map_or(false, |t| t == "image" || t == "image_url")
                || b.get("image_url").filter(|v| !v.is_null()).is_some()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[test]
    fn wildcard_cases() {
        assert!(wildcard_match("*sonnet*", "claude-sonnet-4-20250514"));
        assert!(wildcard_match("*Sonnet*", "CLAUDE-SONNET-4")); // 大小写不敏感
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("gpt-4o", "gpt-4o"));
        assert!(!wildcard_match("*opus*", "claude-sonnet-4"));
        assert!(!wildcard_match("sonnet", "claude-sonnet-4")); // 无通配需全等
        assert!(wildcard_match("claude-*-4", "claude-sonnet-4"));
    }

    #[test]
    fn detect_role_from_seed_rules() {
        let db = Db::new_in_memory().unwrap();
        let conn = db.conn();
        let conn = conn.lock();
        assert_eq!(
            detect_role(&conn, "claude-sonnet-4-20250514"),
            Some("sonnet".to_string())
        );
        assert_eq!(
            detect_role(&conn, "claude-opus-4"),
            Some("opus".to_string())
        );
        assert_eq!(
            detect_role(&conn, "claude-haiku-3"),
            Some("haiku".to_string())
        );
        assert_eq!(
            detect_role(&conn, "claude-fable-5"),
            Some("fable".to_string())
        );
        assert_eq!(detect_role(&conn, "gpt-4o"), None);
    }

    #[test]
    fn higher_priority_rule_wins() {
        let db = Db::new_in_memory().unwrap();
        let conn = db.conn();
        {
            let conn = conn.lock();
            conn.execute(
                "INSERT INTO role_patterns (id,pattern,role,priority,enabled) VALUES ('px','*sonnet-4*','custom-sonnet',200,1)",
                [],
            )
            .unwrap();
            assert_eq!(
                detect_role(&conn, "claude-sonnet-4"),
                Some("custom-sonnet".to_string())
            );
        }
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;
    use crate::protocol::types::{ChatMessage, ChatRequest};
    use serde_json::json;

    fn chat(content: serde_json::Value) -> ChatRequest {
        ChatRequest {
            model: "gpt-4o".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content,
            }],
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        }
    }

    #[test]
    fn detects_openai_image_url() {
        let c = chat(json!([
            { "type": "text", "text": "看这个" },
            { "type": "image_url", "image_url": { "url": "http://a/b.png" } }
        ]));
        assert!(is_image_request(&c));
    }

    #[test]
    fn detects_anthropic_image_block() {
        let c = chat(json!([
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "x" } }
        ]));
        assert!(is_image_request(&c));
    }

    #[test]
    fn plain_text_is_not_image() {
        assert!(!is_image_request(&chat(json!("hello"))));
        assert!(!is_image_request(&chat(json!([{ "type": "text", "text": "only text" }]))));
    }

    #[test]
    fn tool_result_image_part_is_detected() {
        // 工具返回里含 input_image（OpenAI 风格）也应命中
        let c = chat(json!([
            { "type": "text", "text": "t" },
            { "type": "input_image", "image_url": "data:image/png;base64,x" }
        ]));
        assert!(is_image_request(&c));
    }
}
