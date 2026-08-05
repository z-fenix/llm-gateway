use crate::db::models::ApiKey;
use crate::proxy::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_api_keys(state: State<AppState>) -> Result<Vec<ApiKey>, String> {
    state.repo.list_api_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_api_key(
    state: State<AppState>,
    name: String,
    quota_total: Option<i64>,
) -> Result<ApiKey, String> {
    let k = ApiKey {
        id: uuid::Uuid::new_v4().to_string(),
        key: crate::auth::generate_key(),
        name,
        enabled: true,
        quota_total,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: chrono::Utc::now().timestamp(),
        last_used_at: None,
    };
    state.repo.insert_api_key(&k).map_err(|e| e.to_string())?;
    Ok(k)
}

#[tauri::command]
pub fn set_api_key_enabled(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state.repo.set_api_key_enabled(&id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_api_key(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_quota(
    state: State<AppState>,
    id: String,
    quota_total: Option<i64>,
) -> Result<(), String> {
    state.repo.update_quota(&id, quota_total).map_err(|e| e.to_string())
}
