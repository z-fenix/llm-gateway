//! 会话管理命令：扫描本地 CLI 会话（claude/codex/gemini）并加载消息/删除。
//! 数据来源是各 CLI 写在磁盘上的会话文件（见 `crate::session_manager`），
//! 与网关请求日志（Logs 页）相互独立。

use crate::session_manager::{self, SessionMessage, SessionMeta};
use std::path::PathBuf;

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())
}

#[tauri::command]
pub fn list_sessions() -> Result<Vec<SessionMeta>, String> {
    Ok(session_manager::scan_sessions(&home()?))
}

#[tauri::command]
pub fn get_session_messages(
    provider_id: String,
    source_path: String,
) -> Result<Vec<SessionMessage>, String> {
    session_manager::load_messages(&provider_id, &source_path)
}

#[tauri::command]
pub fn delete_session(
    provider_id: String,
    session_id: String,
    source_path: String,
) -> Result<bool, String> {
    session_manager::delete_session(&provider_id, &session_id, &source_path)
}
