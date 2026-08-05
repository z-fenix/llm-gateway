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
        let conn = conn.lock().unwrap();
        assert_eq!(
            detect_role(&conn, "claude-sonnet-4-20250514"),
            Some("sonnet".to_string())
        );
        assert_eq!(detect_role(&conn, "claude-opus-4"), Some("opus".to_string()));
        assert_eq!(detect_role(&conn, "claude-haiku-3"), Some("haiku".to_string()));
        assert_eq!(detect_role(&conn, "claude-fable-5"), Some("fable".to_string()));
        assert_eq!(detect_role(&conn, "gpt-4o"), None);
    }

    #[test]
    fn higher_priority_rule_wins() {
        let db = Db::new_in_memory().unwrap();
        let conn = db.conn();
        {
            let conn = conn.lock().unwrap();
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
