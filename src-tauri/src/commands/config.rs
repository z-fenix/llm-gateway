use crate::config::backup;
use crate::proxy::state::AppState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn export_config(state: State<AppState>, path: String) -> Result<u64, String> {
    backup::export_to_file(&state, &PathBuf::from(path))
}

#[tauri::command]
pub fn default_export_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("llm-gateway-config.json").display().to_string()
}
