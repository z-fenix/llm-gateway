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

/// 按时间邻近回退匹配：取同 provider 中 last_active/created 与 ts_ms 最接近的 session。
/// 时间戳统一为毫秒（SessionMeta 与前端 `new Date(ts)` 均为毫秒），窗口为毫秒。
pub fn match_session_by_time<'a>(
    sessions: &'a [SessionMeta],
    provider_id: &str,
    ts_ms: i64,
    window_ms: i64,
) -> Option<&'a SessionMeta> {
    let mut best: Option<&SessionMeta> = None;
    let mut best_diff = i64::MAX;
    for s in sessions {
        if s.provider_id != provider_id {
            continue;
        }
        let s_ts = s.last_active_at.or(s.created_at).unwrap_or(0);
        let diff = (s_ts - ts_ms).abs();
        if diff <= window_ms && diff < best_diff {
            best = Some(s);
            best_diff = diff;
        }
    }
    best
}

/// 为请求日志解析应绑定的 session：优先从请求体里取会话 ID 精确匹配，
/// 其次将请求的首/末用户消息与会话文件记录做内容匹配，
/// 最后按协议→provider + 最近活跃时间回退匹配。`ts` 为毫秒时间戳。
pub fn resolve_log_session(
    sessions: &[SessionMeta],
    protocol: &str,
    raw_body: &serde_json::Value,
    ts: i64,
) -> (Option<String>, Option<String>) {
    resolve_log_session_with(
        sessions,
        protocol,
        raw_body,
        ts,
        &session_content_bounds_loader,
    )
}

/// 内容匹配候选窗口（毫秒）：只对最近 24h 内活跃的同 provider 会话读文件比对。
const CONTENT_MATCH_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// 内容匹配最多读取的会话文件数（按时间距离取最近）。
const CONTENT_MATCH_MAX_CANDIDATES: usize = 8;

/// loader：从会话元数据对应的文件提取 (首条用户消息, 末条用户消息) 文本。
pub type ContentBoundsLoader<'a> =
    dyn Fn(&SessionMeta) -> Option<(Option<String>, Option<String>)> + 'a;

pub fn resolve_log_session_with(
    sessions: &[SessionMeta],
    protocol: &str,
    raw_body: &serde_json::Value,
    ts: i64,
    loader: &ContentBoundsLoader,
) -> (Option<String>, Option<String>) {
    let provider = match session_provider_from_protocol(protocol) {
        Some(p) => p,
        None => return (None, None),
    };
    // ① 精确匹配：metadata.user_id 尾段 / 消息级 sessionId
    if let Some(sid) = crate::protocol::types::extract_session_id(raw_body) {
        if let Some(s) = find_session_by_id(sessions, provider, &sid) {
            return (Some(s.session_id.clone()), Some(s.provider_id.clone()));
        }
    }
    // ② 内容匹配：不受 ±5 分钟时间窗口限制，适合并发会话消歧
    let (req_first, req_last) = request_user_message_texts(raw_body);
    if req_first.is_some() || req_last.is_some() {
        let mut candidates: Vec<&SessionMeta> = sessions
            .iter()
            .filter(|s| {
                s.provider_id == provider
                    && s.source_path.is_some()
                    && s.last_active_at
                        .or(s.created_at)
                        .is_some_and(|t| (t - ts).abs() <= CONTENT_MATCH_WINDOW_MS)
            })
            .collect();
        candidates.sort_by_key(|s| {
            s.last_active_at
                .or(s.created_at)
                .unwrap_or(0)
                .saturating_sub(ts)
                .abs()
        });
        candidates.truncate(CONTENT_MATCH_MAX_CANDIDATES);

        let req_first_n = req_first.as_deref().map(normalize_for_match);
        let req_last_n = req_last.as_deref().map(normalize_for_match);
        // 先比末条（会话中段也唯一），再比首条（新会话首轮首末相同）
        for use_last in [true, false] {
            let req_text = if use_last {
                req_last_n.as_deref()
            } else {
                req_first_n.as_deref()
            };
            let Some(req_text) = req_text else {
                continue;
            };
            if req_text.is_empty() {
                continue;
            }
            for s in &candidates {
                let Some((s_first, s_last)) = loader(s) else {
                    continue;
                };
                let s_text = if use_last { s_last } else { s_first };
                let Some(s_text) = s_text else {
                    continue;
                };
                if !s_text.trim().is_empty() && normalize_for_match(&s_text) == req_text {
                    return (Some(s.session_id.clone()), Some(s.provider_id.clone()));
                }
            }
        }
    }
    // ③ 时间邻近回退（±5 分钟）
    match match_session_by_time(sessions, provider, ts, 300_000) {
        Some(s) => (Some(s.session_id.clone()), Some(s.provider_id.clone())),
        None => (None, None),
    }
}

/// 归一化文本用于比较：折叠所有空白（请求与会话文件对同一段文本的
/// 转义/换行可能略有差异，但词序列一致）。
fn normalize_for_match(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从原始请求体提取 (首条, 末条) 「有文本内容」的用户消息。
/// 覆盖 chat（messages）与 Responses（input）两种形态；
/// 纯 tool_result 的用户消息没有文本，会被跳过。
pub fn request_user_message_texts(body: &serde_json::Value) -> (Option<String>, Option<String>) {
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    let arrays = [
        body.get("messages").and_then(|m| m.as_array()),
        body.get("input").and_then(|i| i.as_array()),
    ];
    for arr in arrays.into_iter().flatten() {
        for item in arr {
            if item.get("role").and_then(|r| r.as_str()) != Some("user") {
                continue;
            }
            // 纯 tool_result 的用户消息是工具输出回传，不是用户输入（与会话侧规则一致）
            if let Some(items) = item.get("content").and_then(|c| c.as_array()) {
                if !items.is_empty()
                    && items.iter().all(|i| {
                        i.get("type").and_then(serde_json::Value::as_str) == Some("tool_result")
                    })
                {
                    continue;
                }
            }
            let text = item
                .get("content")
                .map(providers::utils::extract_text)
                .unwrap_or_default();
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            if first.is_none() {
                first = Some(trimmed.to_string());
            }
            last = Some(trimmed.to_string());
        }
    }
    (first, last)
}

/// 默认 loader：按会话元数据里的 provider 与 source_path 读取文件。
fn session_content_bounds_loader(s: &SessionMeta) -> Option<(Option<String>, Option<String>)> {
    let path = s.source_path.as_deref()?;
    session_content_bounds(&s.provider_id, path)
}

/// 从会话文件提取 (首条, 末条) 用户消息文本，供内容匹配使用。
/// 只读头尾若干行，不整文件加载。
pub fn session_content_bounds(
    provider_id: &str,
    source_path: &str,
) -> Option<(Option<String>, Option<String>)> {
    let path = Path::new(source_path);
    match provider_id {
        "claude" => providers::claude::content_bounds(path),
        "codex" => providers::codex::content_bounds(path),
        "gemini" => providers::gemini::content_bounds(path),
        _ => None,
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
    fn match_session_by_time_uses_millisecond_timestamps() {
        // 回归：SessionMeta 时间戳为毫秒，窗口也按毫秒比较。
        // 若调用方误传秒级时间戳或误用秒级窗口，回退匹配将永远落空（日志 session_id 恒为空）。
        let now_ms = 1_771_061_953_033_i64;
        let sessions = vec![sess("claude", "recent", now_ms - 2_000)];
        assert_eq!(
            match_session_by_time(&sessions, "claude", now_ms, 300_000)
                .map(|s| s.session_id.as_str()),
            Some("recent")
        );
    }

    /// 内容匹配测试用：sess() 默认无 source_path，会被候选过滤掉
    fn sess_with_path(provider_id: &str, session_id: &str, ts: i64) -> SessionMeta {
        let mut s = sess(provider_id, session_id, ts);
        s.source_path = Some(format!("/{session_id}.jsonl"));
        s
    }

    #[test]
    fn resolve_log_session_binds_by_first_user_message_beyond_time_window() {
        // 会话 2 小时前活跃（超出 ±5 分钟时间回退窗口），
        // 但请求首条用户消息与会话文件记录一致 → 仍应绑定。
        let ts = 1_771_061_953_033_i64;
        let sessions = vec![sess_with_path("claude", "s-old", ts - 7_200_000)];
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "user", "content": "帮我把登录页改成暗色主题"},
                {"role": "assistant", "content": "好的"},
                {"role": "user", "content": "顺便把字号调大"}
            ]
        });
        let (sid, provider) = resolve_log_session_with(&sessions, "anthropic", &body, ts, &|_s| {
            Some((Some("帮我把登录页改成暗色主题".into()), None))
        });
        assert_eq!(sid.as_deref(), Some("s-old"));
        assert_eq!(provider.as_deref(), Some("claude"));
    }

    #[test]
    fn resolve_log_session_binds_by_last_user_message() {
        // 首条不同（如 CLI 注入了统一的 caveat），末条一致 → 仍应绑定。
        let ts = 1_771_061_953_033_i64;
        let sessions = vec![sess_with_path("claude", "s-mid", ts - 600_000)];
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [
                {"role": "user", "content": "完全不同的开头"},
                {"role": "user", "content": "现在的最新输入"}
            ]
        });
        let (sid, _) = resolve_log_session_with(&sessions, "anthropic", &body, ts, &|_s| {
            Some((Some("别的会话的开头".into()), Some("现在的最新输入".into())))
        });
        assert_eq!(sid.as_deref(), Some("s-mid"));
    }

    #[test]
    fn resolve_log_session_content_match_normalizes_whitespace() {
        let ts = 1_771_061_953_033_i64;
        let sessions = vec![sess_with_path("codex", "s-ws", ts - 60_000)];
        let body = serde_json::json!({
            "model": "gpt-5",
            "messages": [{"role": "user", "content": "修复  空白差异\n的匹配"}]
        });
        let (sid, _) = resolve_log_session_with(&sessions, "openai", &body, ts, &|_s| {
            Some((None, Some("修复 空白差异 的匹配".into())))
        });
        assert_eq!(sid.as_deref(), Some("s-ws"));
    }

    #[test]
    fn resolve_log_session_content_match_requires_text_equality() {
        // 文本不一致且超出时间窗口 → 不绑定（宁缺勿错）
        let ts = 1_771_061_953_033_i64;
        let sessions = vec![sess_with_path("claude", "s-other", ts - 600_000)];
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [{"role": "user", "content": "请求里的消息"}]
        });
        let (sid, provider) = resolve_log_session_with(&sessions, "anthropic", &body, ts, &|_s| {
            Some((Some("会话文件里的消息".into()), None))
        });
        assert_eq!(sid, None);
        assert_eq!(provider, None);
    }

    #[test]
    fn resolve_log_session_content_match_skips_sessions_without_source_path() {
        // 无 source_path 的会话不能进内容匹配候选；时间上也超出回退窗口 → 不绑定
        let ts = 1_771_061_953_033_i64;
        let mut s = sess("claude", "s-nopath", ts - 7_200_000);
        s.source_path = None;
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "messages": [{"role": "user", "content": "任意消息"}]
        });
        let (sid, _) =
            resolve_log_session_with(&[s], "anthropic", &body, ts, &|_s: &SessionMeta| {
                panic!("loader must not be called without source_path");
            });
        assert_eq!(sid, None);
    }

    #[test]
    fn request_user_message_texts_skips_tool_results_and_non_user() {
        let body = serde_json::json!({
            "messages": [
                {"role": "user", "content": [{"type": "tool_result", "content": "tool output"}]},
                {"role": "assistant", "content": "回复"},
                {"role": "user", "content": [{"type": "text", "text": "真实的用户输入"}]}
            ]
        });
        let (first, last) = request_user_message_texts(&body);
        assert_eq!(first.as_deref(), Some("真实的用户输入"));
        assert_eq!(last.as_deref(), Some("真实的用户输入"));
    }

    #[test]
    fn request_user_message_texts_handles_string_and_input_arrays() {
        let chat = serde_json::json!({
            "messages": [
                {"role": "user", "content": "第一条"},
                {"role": "user", "content": "第二条"}
            ]
        });
        let (first, last) = request_user_message_texts(&chat);
        assert_eq!(first.as_deref(), Some("第一条"));
        assert_eq!(last.as_deref(), Some("第二条"));

        let responses = serde_json::json!({
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "唯一一条"}]}
            ]
        });
        let (first, last) = request_user_message_texts(&responses);
        assert_eq!(first.as_deref(), Some("唯一一条"));
        assert_eq!(last.as_deref(), Some("唯一一条"));
    }

    #[test]
    fn resolve_log_session_prefers_session_id_exact_match() {
        let ts = 1_771_061_953_000_i64;
        let sessions = vec![
            sess("claude", "session-abc", ts),
            sess("claude", "other", ts + 30_000),
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
        let ts = 1_771_061_953_000_i64;
        let sessions = vec![
            sess("codex", "codex-recent", ts + 30_000),
            sess("codex", "codex-old", ts - 400_000),
        ];
        let body =
            serde_json::json!({"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]});
        let (sid, provider) = resolve_log_session(&sessions, "openai", &body, ts);
        assert_eq!(sid.as_deref(), Some("codex-recent"));
        assert_eq!(provider.as_deref(), Some("codex"));
    }

    #[test]
    fn resolve_log_session_ignores_outside_time_window() {
        let ts = 1_771_061_953_000_i64;
        let sessions = vec![sess("claude", "far", ts - 400_000)];
        let body = serde_json::json!({"model": "claude-opus", "messages": []});
        let (sid, provider) = resolve_log_session(&sessions, "anthropic", &body, ts);
        assert_eq!(sid, None);
        assert_eq!(provider, None);
    }

    #[test]
    fn resolve_log_session_extracts_from_input_array() {
        let ts = 1_771_061_953_000_i64;
        let sessions = vec![sess("codex", "resp-session", ts)];
        let body = serde_json::json!({
            "model": "gpt-4o",
            "input": [{"type": "message", "role": "user", "content": "hi", "sessionId": "resp-session"}]
        });
        let (sid, provider) = resolve_log_session(&sessions, "responses", &body, ts + 10_000);
        assert_eq!(sid.as_deref(), Some("resp-session"));
        assert_eq!(provider.as_deref(), Some("codex"));
    }
}
