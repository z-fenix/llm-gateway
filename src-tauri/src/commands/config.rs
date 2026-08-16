use crate::cli_config::{claude_code, codex, CliWriteResult};
use crate::config::backup;
use crate::config::restore;
use crate::config::settings;
use crate::proxy::state::AppState;
use serde::Serialize;
use serde_json::json;
use std::net::SocketAddr;
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

    match app.store("store.bin") {
        Ok(store) => {
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
        Err(e) => {
            log::error!("import: cannot open store.bin to persist settings: {}", e);
        }
    }

    Ok(result)
}

#[derive(Serialize)]
pub struct AppConfigInfo {
    pub preferred_port: u16,
    pub bound_addr: Option<String>,
}

#[derive(Serialize)]
pub struct CliTargetInfo {
    pub target: String,
    pub configured: bool,
    pub path: String,
}

pub fn resolve_base_url(bound: Option<SocketAddr>) -> Result<String, String> {
    bound.map(|a| format!("http://{}", a)).ok_or_else(|| "网关未启动".to_string())
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())
}

#[tauri::command]
pub fn get_app_config(state: State<AppState>) -> AppConfigInfo {
    AppConfigInfo {
        preferred_port: state.app.read().preferred_port,
        bound_addr: state.bound_addr.read().map(|a| a.to_string()),
    }
}

#[tauri::command]
pub fn set_preferred_port(
    app: AppHandle,
    state: State<AppState>,
    port: u16,
) -> Result<(), String> {
    if !(settings::MIN_PORT..=settings::MAX_PORT).contains(&port) {
        return Err(format!(
            "端口须在 {}..={}",
            settings::MIN_PORT,
            settings::MAX_PORT
        ));
    }
    state.app.write().preferred_port = port;
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("app.preferred_port", json!(port));
        let _ = store.save();
    }
    Ok(())
}

#[tauri::command]
pub fn get_cli_targets(state: State<AppState>) -> Vec<CliTargetInfo> {
    let bound = state.bound_addr.read().map(|a| a.to_string());
    let mut out = vec![];
    if let Ok(h) = home() {
        let sp = claude_code::settings_path(&h);
        let configured = std::fs::read_to_string(&sp)
            .ok()
            .zip(bound.clone())
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo {
            target: "claude_code".into(),
            configured,
            path: sp.display().to_string(),
        });
        let cp = codex::config_path(&h);
        let configured = std::fs::read_to_string(&cp)
            .ok()
            .zip(bound)
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo {
            target: "codex".into(),
            configured,
            path: cp.display().to_string(),
        });
    }
    out
}

#[tauri::command]
pub fn write_cli_config(
    state: State<AppState>,
    target: String,
    api_key_id: String,
    write_env: bool,
) -> Result<Vec<CliWriteResult>, String> {
    let base_url = resolve_base_url(*state.bound_addr.read())?;
    let keys = state.repo.list_api_keys().map_err(|e| e.to_string())?;
    let key = keys
        .into_iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| "API 密钥不存在".to_string())?;
    let h = home()?;
    match target.as_str() {
        "claude_code" => claude_code::write(&h, &base_url, &key.key),
        "codex" => {
            let r = codex::write(&h, &format!("{}/v1", base_url), &key.key, write_env)?;
            Ok(vec![r])
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_base_url_requires_bound() {
        assert!(resolve_base_url(None).is_err());
        let addr: std::net::SocketAddr = "127.0.0.1:8779".parse().unwrap();
        assert_eq!(resolve_base_url(Some(addr)).unwrap(), "http://127.0.0.1:8779");
    }
}
