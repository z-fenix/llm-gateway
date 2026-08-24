//! 会话管理：扫描本地 CLI（claude / codex / gemini）的会话文件，提供列表/消息/删除。
//!
//! 移植自 cc-switch 的 `session_manager`，只保留网关支持的三个 CLI。会话来源是各 CLI
//! 写在本地的会话记录，而非网关请求日志：
//! - claude: `~/.claude/projects/*/*.jsonl`
//! - codex:  `~/.codex/sessions/*.jsonl` + `archived_sessions`
//! - gemini: `~/.gemini/tmp/<project>/chats/session-*.json`

pub mod providers;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use providers::{claude, codex, gemini};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub provider_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionRequest {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionOutcome {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 并发扫描三个 provider 的会话，按 last_active/created 降序返回。
pub fn scan_sessions(home: &Path) -> Vec<SessionMeta> {
    let (r1, r2, r3) = std::thread::scope(|s| {
        let h1 = s.spawn(|| claude::scan_sessions(home));
        let h2 = s.spawn(|| codex::scan_sessions(home));
        let h3 = s.spawn(|| gemini::scan_sessions(home));
        (
            h1.join().unwrap_or_default(),
            h2.join().unwrap_or_default(),
            h3.join().unwrap_or_default(),
        )
    });

    let mut sessions = Vec::new();
    sessions.extend(r1);
    sessions.extend(r2);
    sessions.extend(r3);

    sessions.sort_by(|a, b| {
        let a_ts = a.last_active_at.or(a.created_at).unwrap_or(0);
        let b_ts = b.last_active_at.or(b.created_at).unwrap_or(0);
        b_ts.cmp(&a_ts)
    });

    sessions
}

pub fn load_messages(provider_id: &str, source_path: &str) -> Result<Vec<SessionMessage>, String> {
    let path = Path::new(source_path);
    match provider_id {
        "codex" => codex::load_messages(path),
        "claude" => claude::load_messages(path),
        "gemini" => gemini::load_messages(path),
        _ => Err(format!("Unsupported provider: {provider_id}")),
    }
}

pub fn delete_session(
    provider_id: &str,
    session_id: &str,
    source_path: &str,
) -> Result<bool, String> {
    let roots = provider_roots(provider_id)?;
    delete_session_with_roots(provider_id, session_id, Path::new(source_path), &roots)
}

pub fn delete_sessions(requests: &[DeleteSessionRequest]) -> Vec<DeleteSessionOutcome> {
    collect_delete_session_outcomes(requests, |request| {
        delete_session(
            &request.provider_id,
            &request.session_id,
            &request.source_path,
        )
    })
}

fn delete_session_with_roots(
    provider_id: &str,
    session_id: &str,
    source_path: &Path,
    roots: &[PathBuf],
) -> Result<bool, String> {
    let validated_source = canonicalize_existing_path(source_path, "session source")?;

    let mut saw_existing_root = false;
    for root in roots {
        if !root.exists() {
            continue;
        }

        saw_existing_root = true;
        let validated_root = canonicalize_existing_path(root, "session root")?;
        if validated_source.starts_with(&validated_root) {
            return match provider_id {
                "codex" => codex::delete_session(&validated_root, &validated_source, session_id),
                "claude" => claude::delete_session(&validated_root, &validated_source, session_id),
                "gemini" => gemini::delete_session(&validated_root, &validated_source, session_id),
                _ => Err(format!("Unsupported provider: {provider_id}")),
            };
        }
    }

    if !saw_existing_root {
        return Err(format!(
            "Session root not found for provider {provider_id}: {}",
            roots
                .first()
                .map(|root| root.display().to_string())
                .unwrap_or_else(|| "<none>".to_string())
        ));
    }

    Err(format!(
        "Session source path is outside provider roots: {}",
        source_path.display()
    ))
}

/// 将网关请求协议映射到本地 session provider id。
pub fn session_provider_from_protocol(protocol: &str) -> Option<&'static str> {
    match protocol {
        "anthropic" => Some("claude"),
        "openai" | "responses" => Some("codex"),
        _ => None,
    }
}

/// 按 sessionId 精确匹配本地 session。
pub fn find_session_by_id<'a>(
    sessions: &'a [SessionMeta],
    provider_id: &str,
    session_id: &str,
) -> Option<&'a SessionMeta> {
    sessions
        .iter()
        .find(|s| s.provider_id == provider_id && s.session_id == session_id)
}

/// 按时间邻近回退匹配：取同 provider 中 last_active/created 与 ts 最接近的 session。
pub fn match_session_by_time<'a>(
    sessions: &'a [SessionMeta],
    provider_id: &str,
    ts: i64,
    window_secs: i64,
) -> Option<&'a SessionMeta> {
    let mut best: Option<&SessionMeta> = None;
    let mut best_diff = i64::MAX;
    for s in sessions {
        if s.provider_id != provider_id {
            continue;
        }
        let s_ts = s.last_active_at.or(s.created_at).unwrap_or(0);
        let diff = (s_ts - ts).abs();
        if diff <= window_secs && diff < best_diff {
            best = Some(s);
            best_diff = diff;
        }
    }
    best
}

/// 为请求日志解析应绑定的 session：优先从请求体消息里取 sessionId 精确匹配，
/// 未命中时按协议→provider + 最近活跃时间回退匹配。
pub fn resolve_log_session(
    sessions: &[SessionMeta],
    protocol: &str,
    raw_body: &serde_json::Value,
    ts: i64,
) -> (Option<String>, Option<String>) {
    let provider = match session_provider_from_protocol(protocol) {
        Some(p) => p,
        None => return (None, None),
    };
    if let Some(sid) = crate::protocol::types::extract_session_id(raw_body) {
        if let Some(s) = find_session_by_id(sessions, provider, &sid) {
            return (Some(s.session_id.clone()), Some(s.provider_id.clone()));
        }
    }
    match match_session_by_time(sessions, provider, ts, 300) {
        Some(s) => (Some(s.session_id.clone()), Some(s.provider_id.clone())),
        None => (None, None),
    }
}

fn provider_roots(provider_id: &str) -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())?;
    let roots = match provider_id {
        "codex" => codex::session_roots(&home),
        "claude" => claude::session_roots(&home),
        "gemini" => gemini::session_roots(&home),
        _ => return Err(format!("Unsupported provider: {provider_id}")),
    };
    Ok(roots)
}

fn canonicalize_existing_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("{label} not found: {}", path.display()));
    }

    path.canonicalize()
        .map_err(|e| format!("Failed to resolve {label} {}: {e}", path.display()))
}

fn collect_delete_session_outcomes<F>(
    requests: &[DeleteSessionRequest],
    mut deleter: F,
) -> Vec<DeleteSessionOutcome>
where
    F: FnMut(&DeleteSessionRequest) -> Result<bool, String>,
{
    requests
        .iter()
        .map(|request| match deleter(request) {
            Ok(true) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: true,
                error: None,
            },
            Ok(false) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: false,
                error: Some("Session was not deleted".to_string()),
            },
            Err(error) => DeleteSessionOutcome {
                provider_id: request.provider_id.clone(),
                session_id: request.session_id.clone(),
                source_path: request.source_path.clone(),
                success: false,
                error: Some(error),
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_codex_session(path: &Path, session_id: &str) {
        std::fs::write(
            path,
            format!(
                "{{\"timestamp\":\"2026-03-06T21:50:12Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{session_id}\",\"cwd\":\"/tmp/project\"}}}}\n\
                 {{\"timestamp\":\"2026-03-06T21:50:13Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":\"hello\"}}}}\n",
            ),
        )
        .unwrap();
    }

    #[test]
    fn accepts_source_path_under_any_allowed_provider_root() {
        let active_root = tempdir().unwrap();
        let archived_root = tempdir().unwrap();
        let source = archived_root.path().join("session.jsonl");
        write_codex_session(&source, "archived-session");

        let deleted = delete_session_with_roots(
            "codex",
            "archived-session",
            &source,
            &[
                active_root.path().to_path_buf(),
                archived_root.path().to_path_buf(),
            ],
        )
        .unwrap();

        assert!(deleted);
        assert!(!source.exists());
    }

    #[test]
    fn rejects_source_path_outside_provider_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = outside.path().join("session.jsonl");
        std::fs::write(&source, "{}").unwrap();

        let err =
            delete_session_with_roots("codex", "session-1", &source, &[root.path().to_path_buf()])
                .unwrap_err();

        assert!(err.contains("outside provider roots"));
    }

    #[test]
    fn rejects_missing_source_path() {
        let root = tempdir().unwrap();
        let missing = root.path().join("missing.jsonl");

        let err =
            delete_session_with_roots("codex", "session-1", &missing, &[root.path().to_path_buf()])
                .unwrap_err();

        assert!(err.contains("session source not found"));
    }

    #[test]
    fn batch_delete_collects_successes_and_failures_in_order() {
        let requests = vec![
            DeleteSessionRequest {
                provider_id: "codex".to_string(),
                session_id: "s1".to_string(),
                source_path: "/tmp/s1".to_string(),
            },
            DeleteSessionRequest {
                provider_id: "claude".to_string(),
                session_id: "s2".to_string(),
                source_path: "/tmp/s2".to_string(),
            },
            DeleteSessionRequest {
                provider_id: "gemini".to_string(),
                session_id: "s3".to_string(),
                source_path: "/tmp/s3".to_string(),
            },
        ];

        let outcomes = collect_delete_session_outcomes(&requests, |request| {
            match request.session_id.as_str() {
                "s1" => Ok(true),
                "s2" => Err("boom".to_string()),
                _ => Ok(false),
            }
        });

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes[0].success);
        assert_eq!(outcomes[0].error, None);
        assert!(!outcomes[1].success);
        assert_eq!(outcomes[1].error.as_deref(), Some("boom"));
        assert!(!outcomes[2].success);
        assert_eq!(
            outcomes[2].error.as_deref(),
            Some("Session was not deleted")
        );
    }

    fn sess(provider_id: &str, session_id: &str, ts: i64) -> SessionMeta {
        SessionMeta {
            provider_id: provider_id.to_string(),
            session_id: session_id.to_string(),
            title: None,
            summary: None,
            project_dir: None,
            created_at: Some(ts),
            last_active_at: Some(ts),
            source_path: None,
            resume_command: None,
        }
    }

    #[test]
    fn resolve_log_session_prefers_session_id_exact_match() {
        let ts = 1_000_000;
        let sessions = vec![
            sess("claude", "session-abc", ts),
            sess("claude", "other", ts + 10),
        ];
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "user", "content": "hi", "sessionId": "session-abc"}
            ]
        });
        let (sid, provider) = resolve_log_session(&sessions, "anthropic", &body, ts + 3600);
        assert_eq!(sid.as_deref(), Some("session-abc"));
        assert_eq!(provider.as_deref(), Some("claude"));
    }

    #[test]
    fn resolve_log_session_falls_back_to_time_proximity() {
        let ts = 1_000_000;
        let sessions = vec![
            sess("codex", "codex-recent", ts + 30),
            sess("codex", "codex-old", ts - 400),
        ];
        let body = serde_json::json!({"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]});
        let (sid, provider) = resolve_log_session(&sessions, "openai", &body, ts);
        assert_eq!(sid.as_deref(), Some("codex-recent"));
        assert_eq!(provider.as_deref(), Some("codex"));
    }

    #[test]
    fn resolve_log_session_ignores_outside_time_window() {
        let ts = 1_000_000;
        let sessions = vec![sess("claude", "far", ts - 400)];
        let body = serde_json::json!({"model": "claude-opus", "messages": []});
        let (sid, provider) = resolve_log_session(&sessions, "anthropic", &body, ts);
        assert_eq!(sid, None);
        assert_eq!(provider, None);
    }

    #[test]
    fn resolve_log_session_extracts_from_input_array() {
        let ts = 1_000_000;
        let sessions = vec![sess("codex", "resp-session", ts)];
        let body = serde_json::json!({
            "model": "gpt-4o",
            "input": [{"type": "message", "role": "user", "content": "hi", "sessionId": "resp-session"}]
        });
        let (sid, provider) = resolve_log_session(&sessions, "responses", &body, ts + 10);
        assert_eq!(sid.as_deref(), Some("resp-session"));
        assert_eq!(provider.as_deref(), Some("codex"));
    }
}
