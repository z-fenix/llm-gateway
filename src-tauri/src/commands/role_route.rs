use crate::db::models::{RolePattern, RoleRoute};
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn list_role_routes(state: State<AppState>) -> Result<Vec<RoleRoute>, String> {
    state.repo.list_role_routes().map_err(|e| e.to_string())
}

/// 新增（id 为空）或更新（id 已有）一条角色路由；同一角色可有多条。
#[tauri::command]
pub fn upsert_role_route(state: State<AppState>, mut route: RoleRoute) -> Result<(), String> {
    if route.id.is_empty() {
        route.id = uuid::Uuid::new_v4().to_string();
    }
    if route.weight <= 0 {
        route.weight = 1;
    }
    route.updated_at = chrono::Utc::now().timestamp();
    state
        .repo
        .upsert_role_route(&route)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_route(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .repo
        .delete_role_route(&id)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakerStatus {
    pub route_id: String,
    pub state: String,
    pub failures: u32,
}

/// 各角色路由熔断器当前状态（closed/open/half_open）。
#[tauri::command]
pub fn get_breaker_status(state: State<AppState>) -> Vec<BreakerStatus> {
    let breakers = state.circuit_breakers.read();
    breakers
        .iter()
        .map(|(id, b)| BreakerStatus {
            route_id: id.clone(),
            state: b.state().label().to_string(),
            failures: b.failures(),
        })
        .collect()
}

#[tauri::command]
pub fn list_role_patterns(state: State<AppState>) -> Result<Vec<RolePattern>, String> {
    state.repo.list_role_patterns().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_role_pattern(state: State<AppState>, mut p: RolePattern) -> Result<(), String> {
    if p.id.is_empty() {
        p.id = uuid::Uuid::new_v4().to_string();
    }
    state
        .repo
        .upsert_role_pattern(&p)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_pattern(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .repo
        .delete_role_pattern(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_fallback(state: State<AppState>) -> Option<(String, String)> {
    state.fallback.read().clone()
}

#[tauri::command]
pub fn set_fallback(
    app: tauri::AppHandle,
    state: State<AppState>,
    channel_id: String,
    model: String,
) {
    let pair = Some((channel_id.clone(), model.clone()));
    *state.fallback.write() = pair.clone();

    // 同步持久化到 tauri-plugin-store
    let value = pair.map(|(c, m)| {
        serde_json::json!({
            "channel_id": c,
            "model": m,
        })
    });
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("fallback", value.unwrap_or(serde_json::Value::Null));
        if let Err(e) = store.save() {
            log::error!("failed to save fallback store: {}", e);
        }
    }
}

#[tauri::command]
pub fn clear_fallback(app: tauri::AppHandle, state: State<AppState>) {
    *state.fallback.write() = None;

    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("fallback", serde_json::Value::Null);
        if let Err(e) = store.save() {
            log::error!("failed to save fallback store: {}", e);
        }
    }
}
