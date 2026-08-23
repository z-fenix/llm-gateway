use crate::proxy::state::AppState;
use serde_json::json;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn get_rectifier_config(state: State<AppState>) -> crate::proxy::rectifier::RectifierConfig {
    state.rectifier.read().clone()
}

#[tauri::command]
pub fn set_rectifier_config(
    state: State<AppState>,
    app: AppHandle,
    key: String,
    value: bool,
) -> Result<(), String> {
    let valid = [
        "enabled",
        "request_thinking_signature",
        "request_thinking_budget",
        "request_media_fallback",
        "request_media_heuristic",
    ];
    if !valid.contains(&key.as_str()) {
        return Err(format!("invalid rectifier key: {key}"));
    }
    let mut cfg = state.rectifier.read().clone();
    match key.as_str() {
        "enabled" => cfg.enabled = value,
        "request_thinking_signature" => cfg.request_thinking_signature = value,
        "request_thinking_budget" => cfg.request_thinking_budget = value,
        "request_media_fallback" => cfg.request_media_fallback = value,
        _ => cfg.request_media_heuristic = value,
    }
    *state.rectifier.write() = cfg;
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set(format!("rectifier.{key}"), json!(value));
        if let Err(e) = store.save() {
            log::error!("failed to save rectifier config: {e}");
        }
    }
    Ok(())
}
