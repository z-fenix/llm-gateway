use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Stats {
    pub today_requests: i64,
    pub today_tokens: i64,
    pub total_requests: i64,
    pub total_tokens: i64,
    pub active_channels: i64,
    pub avg_latency_ms: i64,
}

#[tauri::command]
pub fn get_stats(state: State<AppState>) -> Result<Stats, String> {
    let (tr, tt, ar, at, ac, lat) = state.repo.stats().map_err(|e| e.to_string())?;
    Ok(Stats {
        today_requests: tr,
        today_tokens: tt,
        total_requests: ar,
        total_tokens: at,
        active_channels: ac,
        avg_latency_ms: lat,
    })
}
