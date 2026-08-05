use crate::db::models::RequestLog;
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
pub struct LogFilter {
    pub keyword: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
pub struct LogPage {
    pub items: Vec<RequestLog>,
    pub total: i64,
}

#[tauri::command]
pub fn list_logs(state: State<AppState>, filter: LogFilter) -> Result<LogPage, String> {
    let kw = filter.keyword.as_deref();
    let items = state
        .repo
        .list_logs(kw, filter.limit.unwrap_or(50), filter.offset.unwrap_or(0))
        .map_err(|e| e.to_string())?;
    let total = state.repo.count_logs(kw).map_err(|e| e.to_string())?;
    Ok(LogPage { items, total })
}
