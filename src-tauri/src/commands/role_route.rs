use crate::db::models::{RolePattern, RoleRoute};
use crate::proxy::state::AppState;
use tauri::State;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn list_role_routes(state: State<AppState>) -> Result<Vec<RoleRoute>, String> {
    state.repo.list_role_routes().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_role_route(
    state: State<AppState>,
    role: String,
    channel_id: String,
    target_model: String,
) -> Result<(), String> {
    let rr = RoleRoute {
        id: uuid::Uuid::new_v4().to_string(),
        role,
        channel_id,
        target_model,
        enabled: true,
        updated_at: chrono::Utc::now().timestamp(),
    };
    state.repo.upsert_role_route(&rr).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_route(state: State<AppState>, role: String) -> Result<(), String> {
    state.repo.delete_role_route(&role).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_role_patterns(state: State<AppState>) -> Result<Vec<RolePattern>, String> {
    state.repo.list_role_patterns().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_role_pattern(
    state: State<AppState>,
    mut p: RolePattern,
) -> Result<(), String> {
    if p.id.is_empty() {
        p.id = uuid::Uuid::new_v4().to_string();
    }
    state.repo.upsert_role_pattern(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_pattern(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_role_pattern(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_fallback(state: State<AppState>) -> Option<(String, String)> {
    state.fallback.read().unwrap().clone()
}

#[tauri::command]
pub fn set_fallback(
    app: tauri::AppHandle,
    state: State<AppState>,
    channel_id: String,
    model: String,
) {
    let pair = Some((channel_id.clone(), model.clone()));
    *state.fallback.write().unwrap() = pair.clone();

    // 同步持久化到 tauri-plugin-store
    let value = pair.map(|(c, m)| {
        serde_json::json!({
            "channel_id": c,
            "model": m,
        })
    });
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("fallback", value.unwrap_or(serde_json::Value::Null));
        let _ = store.save();
    }
}

#[tauri::command]
pub fn clear_fallback(app: tauri::AppHandle, state: State<AppState>) {
    *state.fallback.write().unwrap() = None;

    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("fallback", serde_json::Value::Null);
        let _ = store.save();
    }
}
