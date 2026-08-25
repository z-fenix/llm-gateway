use crate::db::repository::RoleStats;
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Stats {
    pub today_requests: i64,
    /// 今日 token 组合口径：input+output（保持不变）
    pub today_tokens: i64,
    pub total_requests: i64,
    pub total_tokens: i64,
    pub active_channels: i64,
    pub avg_latency_ms: i64,
    pub today_input_tokens: i64,
    pub today_output_tokens: i64,
    pub today_cache_read_tokens: i64,
    pub today_cache_creation_tokens: i64,
    /// 今日去重缓存后的 fresh input（含缓存型协议 input 已含缓存，需扣减）
    pub today_fresh_input: i64,
    /// 今日总成本（USD）
    pub today_cost: f64,
    /// 历史总成本（USD）
    pub total_cost: f64,
}

#[tauri::command]
pub fn get_stats(state: State<AppState>) -> Result<Stats, String> {
    let (tr, tt, ar, at, ac, lat, tii, too, tcr, tcc, tfresh, tcost, tcost_total) =
        state.repo.stats().map_err(|e| e.to_string())?;
    Ok(Stats {
        today_requests: tr,
        today_tokens: tt,
        total_requests: ar,
        total_tokens: at,
        active_channels: ac,
        avg_latency_ms: lat,
        today_input_tokens: tii,
        today_output_tokens: too,
        today_cache_read_tokens: tcr,
        today_cache_creation_tokens: tcc,
        today_fresh_input: tfresh,
        today_cost: tcost,
        total_cost: tcost_total,
    })
}

#[tauri::command]
pub fn get_role_stats(state: State<AppState>) -> Result<Vec<RoleStats>, String> {
    state.repo.role_stats().map_err(|e| e.to_string())
}
