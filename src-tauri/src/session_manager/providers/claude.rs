use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{
    extract_text, parse_timestamp_to_ms, path_basename, read_head_tail_lines, truncate_summary,
    TITLE_MAX_CHARS,
};

const PROVIDER_ID: &str = "claude";

/// Claude 本地会话根目录：`~/.claude/projects`。
pub fn session_roots(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".claude").join("projects")]
}

pub fn scan_sessions(home: &Path) -> Vec<SessionMeta> {
    let root = session_roots(home).remove(0);
    let mut files = Vec::new();
    collect_jsonl_files(&root, &mut files);

    let mut sessions = Vec::new();
    for path in files {
        if let Some(meta) = parse_session(&path) {
            sessions.push(meta);
        }
    }

    sessions
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open session file: {e}"))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(value) => value,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };

        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }

        let message = match value.get("message") {
            Some(message) => message,
            None => continue,
        };

        let mut role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        // Claude 把 tool_result 包在 user 消息里；重分类为 "tool"。
        if role == "user" {
            if let Some(Value::Array(items)) = message.get("content") {
                let all_tool_results = !items.is_empty()
                    && items.iter().all(|item| {
                        item.get("type").and_then(Value::as_str) == Some("tool_result")
                    });
                if all_tool_results {
                    role = "tool".to_string();
                }
            }
        }

        let content = message.get("content").map(extract_text).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }

        let ts = value.get("timestamp").and_then(parse_timestamp_to_ms);

        messages.push(SessionMessage { role, content, ts });
    }

    Ok(messages)
}

pub fn delete_session(_root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    let meta = parse_session(path).ok_or_else(|| {
        format!(
            "Failed to parse Claude session metadata: {}",
            path.display()
        )
    })?;

    if meta.session_id != session_id {
        return Err(format!(
            "Claude session ID mismatch: expected {session_id}, found {}",
            meta.session_id
        ));
    }

    if let Some(stem) = path.file_stem() {
        let sibling = path.parent().unwrap_or_else(|| Path::new("")).join(stem);
        remove_path_if_exists(&sibling).map_err(|e| {
            format!(
                "Failed to delete Claude session sidecar {}: {e}",
                sibling.display()
            )
        })?;
    }

    std::fs::remove_file(path).map_err(|e| {
        format!(
            "Failed to delete Claude session file {}: {e}",
            path.display()
        )
    })?;

    Ok(true)
}

fn parse_session(path: &Path) -> Option<SessionMeta> {
    if is_agent_session(path) {
        return None;
    }

    let (head, tail) = read_head_tail_lines(path, 10, 30).ok()?;

    let mut session_id: Option<String> = None;
    let mut project_dir: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut first_user_message: Option<String> = None;

    // 从头部提取元数据与首条真实用户消息
    for line in &head {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
        if project_dir.is_none() {
            project_dir = value
                .get("cwd")
                .and_then(Value::as_str)
                .map(|s| s.to_string());
        }
        if created_at.is_none() {
            created_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        // 标题候选：跳过系统注入 caveat 与斜杠命令（/clear、/compact 等）
        if first_user_message.is_none() {
            let is_user = value.get("type").and_then(Value::as_str) == Some("user")
                || value
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str)
                    == Some("user");
            if is_user {
                if let Some(message) = value.get("message") {
                    let text = message.get("content").map(extract_text).unwrap_or_default();
                    let trimmed = text.trim();
                    if !trimmed.is_empty()
                        && !trimmed.contains("<local-command-caveat>")
                        && !trimmed.starts_with("<command-name>")
                    {
                        first_user_message = Some(trimmed.to_string());
                    }
                }
            }
        }
        if session_id.is_some()
            && project_dir.is_some()
            && created_at.is_some()
            && first_user_message.is_some()
        {
            break;
        }
    }

    // 从尾部提取 last_active_at、summary、自定义标题（逆序）
    let mut last_active_at: Option<i64> = None;
    let mut summary: Option<String> = None;
    let mut custom_title: Option<String> = None;

    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if last_active_at.is_none() {
            last_active_at = value.get("timestamp").and_then(parse_timestamp_to_ms);
        }
        if custom_title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("custom-title")
        {
            custom_title = value
                .get("customTitle")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
        if summary.is_none() {
            if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if let Some(message) = value.get("message") {
                let text = message.get("content").map(extract_text).unwrap_or_default();
                if !text.trim().is_empty() {
                    summary = Some(text);
                }
            }
        }
        if last_active_at.is_some() && summary.is_some() && custom_title.is_some() {
            break;
        }
    }

    let session_id = session_id.or_else(|| infer_session_id_from_filename(path));
    let session_id = session_id?;

    // 标题优先级：自定义标题 > 首条用户消息 > 项目目录名
    let title = custom_title
        .map(|t| truncate_summary(&t, TITLE_MAX_CHARS))
        .or_else(|| first_user_message.map(|t| truncate_summary(&t, TITLE_MAX_CHARS)))
        .or_else(|| {
            project_dir
                .as_deref()
                .and_then(path_basename)
                .map(|v| v.to_string())
        });

    let summary = summary.map(|text| truncate_summary(&text, 160));

    Some(SessionMeta {
        provider_id: PROVIDER_ID.to_string(),
        session_id: session_id.clone(),
        title,
        summary,
        project_dir,
        created_at,
        last_active_at,
        source_path: Some(path.to_string_lossy().to_string()),
        resume_command: Some(format!("claude --resume {session_id}")),
    })
}

fn is_agent_session(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-"))
        .unwrap_or(false)
}

fn infer_session_id_from_filename(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_string())
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }

    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_session_lines(path: &Path, lines: &[&str]) {
        std::fs::write(path, lines.join("\n")).unwrap();
    }

    #[test]
    fn parse_session_uses_first_user_message_as_title() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("abc-123.jsonl");
        write_session_lines(
            &path,
            &[
                r#"{"type":"user","sessionId":"abc-123","cwd":"/repo/app","timestamp":"2026-03-06T10:00:00Z","message":{"role":"user","content":"Fix the login bug"}}"#,
                r#"{"type":"assistant","timestamp":"2026-03-06T10:00:05Z","message":{"role":"assistant","content":"On it."}}"#,
            ],
        );

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.provider_id, "claude");
        assert_eq!(meta.session_id, "abc-123");
        assert_eq!(meta.project_dir.as_deref(), Some("/repo/app"));
        assert_eq!(meta.title.as_deref(), Some("Fix the login bug"));
        assert!(meta.created_at.is_some());
        assert!(meta.last_active_at.is_some());
        assert_eq!(
            meta.resume_command.as_deref(),
            Some("claude --resume abc-123")
        );
    }

    #[test]
    fn parse_session_skips_slash_command_injected_lines_for_title() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("abc.jsonl");
        write_session_lines(
            &path,
            &[
                r#"{"type":"user","message":{"role":"user","content":"<local-command-caveat>ignored</local-command-caveat>"}}"#,
                r#"{"type":"user","message":{"role":"user","content":"real question"}}"#,
            ],
        );

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("real question"));
    }

    #[test]
    fn parse_session_falls_back_to_project_basename_title() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("zzz.jsonl");
        // 无有效用户消息（内容为空）→ 标题回退到项目目录名
        write_session_lines(
            &path,
            &[r#"{"type":"user","cwd":"/repo/my-project","message":{"role":"user","content":""}}"#],
        );

        let meta = parse_session(&path).unwrap();
        assert_eq!(meta.title.as_deref(), Some("my-project"));
    }

    #[test]
    fn load_messages_parses_roles_and_reclassifies_tool_results() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        write_session_lines(
            &path,
            &[
                r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]}}"#,
                r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"text","text":"ls output"}]}]}}"#,
                r#"{"isMeta":true,"message":{"role":"assistant","content":"summary"}}"#,
            ],
        );

        let msgs = load_messages(&path).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].content, "hi back");
        assert_eq!(msgs[2].role, "tool");
        assert_eq!(msgs[2].content, "ls output");
    }

    #[test]
    fn scan_skips_agent_sessions() {
        let dir = tempdir().unwrap();
        let root = dir.path().join(".claude").join("projects");
        std::fs::create_dir_all(&root).unwrap();
        let normal = root.join("abc.jsonl");
        let agent = root.join("agent-xyz.jsonl");
        write_session_lines(&normal, &[r#"{"type":"user","message":{"role":"user","content":"q"}}"#]);
        write_session_lines(&agent, &[r#"{"type":"user","message":{"role":"user","content":"sub"}}"#]);

        let sessions = scan_sessions(dir.path());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "abc");
    }

    #[test]
    fn delete_session_removes_main_file_and_sidecar_directory() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("abc-session.jsonl");
        let sidecar = dir.path().join("abc-session");
        let subagents = sidecar.join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        std::fs::write(subagents.join("agent-1.jsonl"), "{}").unwrap();
        write_session_lines(
            &path,
            &[r#"{"type":"user","sessionId":"abc-session","cwd":"/x","message":{"role":"user","content":"q"}}"#],
        );

        delete_session(dir.path(), &path, "abc-session").unwrap();
        assert!(!path.exists());
        assert!(!sidecar.exists());
    }
}
