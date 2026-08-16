use crate::config::backup;
use crate::config::restore;
use crate::proxy::state::AppState;
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn export_config(state: State<AppState>, path: String) -> Result<u64, String> {
    backup::export_to_file(&state, &PathBuf::from(path))
}

#[tauri::command]
pub fn default_export_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("llm-gateway-config.json").display().to_string()
}

#[tauri::command]
pub fn preview_import(
    state: State<AppState>,
    path: String,
) -> Result<restore::ImportPreview, String> {
    let bundle = restore::parse_bundle(&PathBuf::from(&path))?;
    Ok(restore::preview(&state, &bundle))
}

#[tauri::command]
pub fn import_config(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    strategy: String,
) -> Result<restore::ImportResult, String> {
    if strategy != "skip" && strategy != "overwrite" {
        return Err("strategy 须为 skip 或 overwrite".into());
    }
    let bundle = restore::parse_bundle(&PathBuf::from(&path))?;
    let result = restore::import(&state, &bundle, &strategy)?;

    if let Ok(store) = app.store("store.bin") {
        let sec = state.security.read().clone();
        let _ = store.set("security.enabled", json!(sec.enabled));
        let _ = store.set("security.mode", json!(sec.mode));
        let _ = store.set("security.scan_request", json!(sec.scan_request));
        let _ = store.set("security.scan_response", json!(sec.scan_response));
        let _ = store.set("security.scan_unicode", json!(sec.scan_unicode));
        let _ = store.set("security.scan_tools", json!(sec.scan_tools));
        let _ = store.set("security.scan_network", json!(sec.scan_network));
        let _ = store.set("security.redact_secrets", json!(sec.redact_secrets));
        let _ = store.set("security.block_on_critical", json!(sec.block_on_critical));
        let _ = store.set("security.max_scan_bytes", json!(sec.max_scan_bytes));
        match state.fallback.read().clone() {
            Some((channel_id, model)) => {
                let _ = store.set("fallback", json!({"channel_id": channel_id, "model": model}));
            }
            None => {
                let _ = store.set("fallback", serde_json::Value::Null);
            }
        }
        let _ = store.set("app.preferred_port", json!(state.app.read().preferred_port));
        if let Err(e) = store.save() {
            log::error!("failed to save store after import: {}", e);
        }
    }

    Ok(result)
}
