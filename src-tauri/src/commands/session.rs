use crate::db::models::{SessionMessage, SessionMeta};
use crate::proxy::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_sessions(state: State<AppState>) -> Result<Vec<SessionMeta>, String> {
    list_sessions_with_state(&state)
}

pub(crate) fn list_sessions_with_state(state: &AppState) -> Result<Vec<SessionMeta>, String> {
    let mut sessions = state.repo.list_sessions().map_err(|e| e.to_string())?;
    // 标题候选：单条查询一次取回每个 trace 的首条 user 消息 request_body，避免 N+1。
    let titles: std::collections::HashMap<String, Option<String>> = state
        .repo
        .list_session_titles()
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    for session in &mut sessions {
        if session.title.is_some() {
            continue;
        }
        if let Some(body) = titles.get(&session.trace_id).cloned().flatten() {
            if let Some(content) = extract_content(Some(&body), 80) {
                session.title = Some(truncate(&content, 80));
            }
        }
    }
    Ok(sessions)
}

#[tauri::command]
pub fn get_session_messages(
    state: State<AppState>,
    trace_id: String,
) -> Result<Vec<SessionMessage>, String> {
    get_session_messages_with_state(&state, &trace_id)
}

pub(crate) fn get_session_messages_with_state(
    state: &AppState,
    trace_id: &str,
) -> Result<Vec<SessionMessage>, String> {
    let logs = state
        .repo
        .get_session_logs(trace_id)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for log in logs {
        let body = if log.role.as_deref() == Some("user")
            || log.role.as_deref().is_none()
            || log.role.as_deref() == Some("")
        {
            log.request_body.as_deref()
        } else {
            log.response_body.as_deref()
        };
        let content = extract_content(body, 200);
        out.push(SessionMessage {
            seq: log.seq,
            role: log.role,
            content,
            status_code: log.status_code,
            created_at: log.created_at,
            error: log.error,
            request_body: log.request_body,
            response_body: log.response_body,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_session(state: State<AppState>, trace_id: String) -> Result<usize, String> {
    delete_session_with_state(&state, &trace_id)
}

pub(crate) fn delete_session_with_state(state: &AppState, trace_id: &str) -> Result<usize, String> {
    state
        .repo
        .delete_session(trace_id)
        .map_err(|e| e.to_string())
}

fn extract_content(body: Option<&str>, max_len: usize) -> Option<String> {
    let body = body?;
    if body.is_empty() {
        return None;
    }
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        // Spec/brief: on JSON parse failure fall back to the first 100 chars of the raw body.
        Err(_) => return Some(truncate(body, 100)),
    };

    // Try messages[0].content (OpenAI/Anthropic request)
    if let Some(content) = json
        .get("messages")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.get("content"))
    {
        if let Some(s) = extract_text_value(content, max_len) {
            return Some(s);
        }
    }

    // Try top-level content (Responses/Anthropic response)
    if let Some(content) = json.get("content") {
        if let Some(s) = extract_text_value(content, max_len) {
            return Some(s);
        }
    }

    // Try choices[0].message.content (OpenAI response)
    if let Some(content) = json
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
    {
        if let Some(s) = extract_text_value(content, max_len) {
            return Some(s);
        }
    }

    // Fallback to raw body truncated to 100 chars per spec/brief.
    Some(truncate(body, 100))
}

fn extract_text_value(value: &serde_json::Value, max_len: usize) -> Option<String> {
    if let Some(s) = value.as_str() {
        return Some(truncate(s, max_len));
    }
    if let Some(arr) = value.as_array() {
        for item in arr {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                return Some(truncate(text, max_len));
            }
            if let Some(s) = item.as_str() {
                return Some(truncate(s, max_len));
            }
        }
    }
    None
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        s.chars().take(max_len).collect::<String>() + "..."
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{ApiKey, Channel, RequestLog, RequestSecurityFinding};
    use crate::db::Db;

    fn test_channel(id: &str) -> Channel {
        Channel {
            id: id.into(),
            name: "n".into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
            base_url: "http://x".into(),
            api_key: "sk-real".into(),
            models: vec!["gpt-4o".into()],
            priority: 0,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn test_api_key() -> ApiKey {
        ApiKey {
            id: "k1".into(),
            key: "sk-lgw-a".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        }
    }

    fn make_log(
        seq: i64,
        trace_id: &str,
        role: Option<&str>,
        request_body: Option<&str>,
        response_body: Option<&str>,
        created_at: i64,
    ) -> RequestLog {
        RequestLog {
            id: format!("l{}", seq),
            seq,
            trace_id: trace_id.into(),
            api_key_id: Some("k1".into()),
            key_name: Some("alice".into()),
            channel_id: Some("ch1".into()),
            channel_name: Some("ch".into()),
            role: role.map(|s| s.into()),
            request_model: Some("gpt-4o".into()),
            upstream_model: Some("gpt-4o".into()),
            protocol: "openai".into(),
            status_code: Some(200),
            input_tokens: 10,
            output_tokens: 10,
            latency_ms: 100,
            is_stream: false,
            error: None,
            fallback: false,
            tool_calls: None,
            request_body: request_body.map(|s| s.into()),
            response_body: response_body.map(|s| s.into()),
            risk_level: "clean".into(),
            risk_score: 0,
            risk_summary: None,
            security_action: "allow".into(),
            sanitized: false,
            blocked_reason: None,
            created_at,
        }
    }

    fn setup_state() -> AppState {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();
        state.repo.insert_api_key(&test_api_key()).unwrap();
        state
    }

    #[test]
    fn list_sessions_enriches_titles() {
        let state = setup_state();
        let long_title = "a".repeat(120);
        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-a",
                Some("user"),
                Some(&format!(
                    "{{\"messages\":[{{\"role\":\"user\",\"content\":\"{}\"}}]}}",
                    long_title
                )),
                None,
                1000,
            ))
            .unwrap();
        state
            .repo
            .insert_log(&make_log(
                2,
                "trace-b",
                Some("user"),
                Some(r#"{"messages":[{"role":"user","content":"Short title"}]}"#),
                None,
                2000,
            ))
            .unwrap();

        let sessions = list_sessions_with_state(&state).unwrap();
        assert_eq!(sessions.len(), 2);
        let a = sessions.iter().find(|s| s.trace_id == "trace-a").unwrap();
        let b = sessions.iter().find(|s| s.trace_id == "trace-b").unwrap();
        assert_eq!(a.title, Some(format!("{}...", "a".repeat(80))));
        assert_eq!(b.title, Some("Short title".into()));
    }

    #[test]
    fn get_session_messages_extracts_content() {
        let state = setup_state();
        let req_body = r#"{"messages":[{"role":"user","content":"User message text"}]}"#;
        let resp_body =
            r#"{"choices":[{"message":{"role":"assistant","content":"Assistant reply text"}}]}"#;

        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-x",
                Some("user"),
                Some(req_body),
                None,
                1000,
            ))
            .unwrap();
        state
            .repo
            .insert_log(&make_log(
                2,
                "trace-x",
                Some("assistant"),
                None,
                Some(resp_body),
                2000,
            ))
            .unwrap();

        let messages = get_session_messages_with_state(&state, "trace-x").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].seq, 1);
        assert_eq!(messages[0].role.as_deref(), Some("user"));
        assert_eq!(messages[0].content, Some("User message text".into()));
        assert_eq!(messages[0].request_body.as_deref(), Some(req_body));
        assert_eq!(messages[0].response_body, None);
        assert_eq!(messages[1].seq, 2);
        assert_eq!(messages[1].role.as_deref(), Some("assistant"));
        assert_eq!(messages[1].content, Some("Assistant reply text".into()));
        assert_eq!(messages[1].request_body, None);
        assert_eq!(messages[1].response_body.as_deref(), Some(resp_body));
    }

    #[test]
    fn get_session_messages_extracts_array_text_blocks() {
        let state = setup_state();
        let req_body =
            r#"{"messages":[{"role":"user","content":[{"type":"text","text":"Vision prompt"}]}]}"#;
        let resp_body = r#"{"content":[{"type":"text","text":"Anthropic reply"}]}"#;

        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-array",
                Some("user"),
                Some(req_body),
                None,
                1000,
            ))
            .unwrap();
        state
            .repo
            .insert_log(&make_log(
                2,
                "trace-array",
                Some("assistant"),
                None,
                Some(resp_body),
                2000,
            ))
            .unwrap();

        let messages = get_session_messages_with_state(&state, "trace-array").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, Some("Vision prompt".into()));
        assert_eq!(messages[1].content, Some("Anthropic reply".into()));
    }

    #[test]
    fn get_session_messages_falls_back_to_raw_body_on_invalid_json() {
        let state = setup_state();
        let raw_body = "this is not json and it is intentionally long enough to test truncation because we want more than one hundred characters in the raw body string";
        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-invalid",
                Some("user"),
                Some(raw_body),
                None,
                1000,
            ))
            .unwrap();

        let messages = get_session_messages_with_state(&state, "trace-invalid").unwrap();
        assert_eq!(messages.len(), 1);
        let expected = raw_body.chars().take(100).collect::<String>() + "...";
        assert_eq!(messages[0].content, Some(expected));
    }

    #[test]
    fn list_sessions_skips_enrichment_errors() {
        let state = setup_state();
        // trace-good has a valid JSON user message.
        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-good",
                Some("user"),
                Some(r#"{"messages":[{"role":"user","content":"Good title"}]}"#),
                None,
                1000,
            ))
            .unwrap();
        // trace-bad has invalid JSON; enrichment should fall back to raw body.
        state
            .repo
            .insert_log(&make_log(
                2,
                "trace-bad",
                Some("user"),
                Some("not valid json but still a title candidate"),
                None,
                2000,
            ))
            .unwrap();

        let sessions = list_sessions_with_state(&state).unwrap();
        assert_eq!(sessions.len(), 2);
        let good = sessions
            .iter()
            .find(|s| s.trace_id == "trace-good")
            .unwrap();
        let bad = sessions.iter().find(|s| s.trace_id == "trace-bad").unwrap();
        assert_eq!(good.title, Some("Good title".into()));
        // The bad trace still gets a title from the raw-body fallback.
        assert_eq!(
            bad.title,
            Some("not valid json but still a title candidate".into())
        );
    }

    #[test]
    fn delete_session_with_state_removes_logs() {
        let state = setup_state();
        state
            .repo
            .insert_log(&make_log(
                1,
                "trace-y",
                Some("user"),
                Some(r#"{"messages":[{"content":"hello"}]}"#),
                None,
                1000,
            ))
            .unwrap();
        state
            .repo
            .insert_log(&make_log(
                2,
                "trace-y",
                Some("assistant"),
                None,
                Some(r#"{"content":"hi"}"#),
                2000,
            ))
            .unwrap();

        let finding = RequestSecurityFinding {
            id: "f1".into(),
            log_id: "l1".into(),
            phase: "request".into(),
            category: "test".into(),
            rule_id: "rule-1".into(),
            severity: "low".into(),
            title: "finding".into(),
            description: None,
            location: None,
            evidence_masked: None,
            evidence_hash: None,
            action: None,
            created_at: 1000,
        };
        state.repo.insert_finding(&finding).unwrap();

        let deleted = delete_session_with_state(&state, "trace-y").unwrap();
        assert_eq!(deleted, 2);

        let messages = get_session_messages_with_state(&state, "trace-y").unwrap();
        assert!(messages.is_empty());
    }
}
