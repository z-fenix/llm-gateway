use crate::db::models::RequestLog;
use crate::db::repository::{LogFilter, LogStats, StatusClass, TimeBucket};
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_store::StoreExt;

#[derive(Deserialize)]
pub struct CommandLogFilter {
    pub keyword: Option<String>,
    pub api_key_id: Option<String>,
    pub channel_id: Option<String>,
    pub role: Option<String>,
    pub risk_level: Option<String>,
    pub status: Option<String>,
    pub is_stream: Option<bool>,
    pub after: Option<i64>,
    pub before: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

impl CommandLogFilter {
    fn to_filter(&self) -> LogFilter {
        LogFilter {
            keyword: self.keyword.clone(),
            api_key_id: self.api_key_id.clone(),
            channel_id: self.channel_id.clone(),
            role: self.role.clone(),
            risk_level: self.risk_level.clone(),
            status: self.status.as_ref().and_then(|s| match s.as_str() {
                "2xx" => Some(StatusClass::Success),
                "4xx" => Some(StatusClass::ClientError),
                "5xx" => Some(StatusClass::ServerError),
                _ => None,
            }),
            is_stream: self.is_stream,
            after: self.after,
            before: self.before,
        }
    }
}

#[derive(Serialize)]
pub struct LogPage {
    pub items: Vec<RequestLog>,
    pub total: i64,
}

#[tauri::command]
pub fn list_logs(state: State<AppState>, filter: CommandLogFilter) -> Result<LogPage, String> {
    let limit = filter.limit.unwrap_or(50);
    let offset = filter.offset.unwrap_or(0);
    let domain_filter = filter.to_filter();
    let items = state
        .repo
        .list_logs(&domain_filter, limit, offset)
        .map_err(|e| e.to_string())?;
    let total = state
        .repo
        .count_logs(&domain_filter)
        .map_err(|e| e.to_string())?;
    Ok(LogPage { items, total })
}

#[tauri::command]
pub fn get_log_stats(state: State<AppState>, filter: CommandLogFilter) -> Result<LogStats, String> {
    state
        .repo
        .log_stats(&filter.to_filter())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_log_timeseries(
    state: State<AppState>,
    filter: CommandLogFilter,
    bucket: i64,
) -> Result<Vec<TimeBucket>, String> {
    state
        .repo
        .log_timeseries(&filter.to_filter(), bucket)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_logs_before(state: State<AppState>, before: i64) -> Result<usize, String> {
    state
        .repo
        .delete_logs_before(before)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_logs(state: State<AppState>) -> Result<usize, String> {
    state.repo.clear_logs().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_log_retention_days(app: tauri::AppHandle, days: i64) -> Result<(), String> {
    if days < 0 {
        return Err("days must be >= 0".into());
    }
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    store.set("log_retention_days", serde_json::json!(days));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_log_retention_days(app: tauri::AppHandle) -> Result<i64, String> {
    let store = app.store("store.bin").map_err(|e| e.to_string())?;
    let days = store
        .get("log_retention_days")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    Ok(days)
}
