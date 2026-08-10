use crate::db::models::{BuiltinRule, CustomRule, RequestSecurityFinding};
use crate::proxy::state::AppState;
use tauri::State;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn get_security_settings(state: State<AppState>) -> Result<crate::security::SecuritySettings, String> {
    Ok(state.security.read().clone())
}

#[tauri::command]
pub fn set_security_setting(
    app: tauri::AppHandle,
    state: State<AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let store_key = format!("security.{}", key);
    {
        let mut settings = state.security.write();
        match key.as_str() {
            "enabled" => {
                settings.enabled = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "mode" => {
                settings.mode = value
                    .as_str()
                    .ok_or_else(|| format!("security.{} must be a string", key))?
                    .to_string();
            }
            "scan_request" => {
                settings.scan_request = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "scan_response" => {
                settings.scan_response = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "scan_unicode" => {
                settings.scan_unicode = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "scan_tools" => {
                settings.scan_tools = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "scan_network" => {
                settings.scan_network = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "redact_secrets" => {
                settings.redact_secrets = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "block_on_critical" => {
                settings.block_on_critical = value
                    .as_bool()
                    .ok_or_else(|| format!("security.{} must be a boolean", key))?;
            }
            "max_scan_bytes" => {
                settings.max_scan_bytes = value
                    .as_u64()
                    .ok_or_else(|| format!("security.{} must be a number", key))? as usize;
            }
            _ => return Err(format!("unknown security setting: {}", key)),
        }
    }

    if let Ok(store) = app.store("store.bin") {
        let _ = store.set(store_key, value);
        if let Err(e) = store.save() {
            log::error!("failed to save security store: {}", e);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_builtin_security_rules(state: State<AppState>) -> Result<Vec<BuiltinRule>, String> {
    let mut rules = state.repo.list_builtin_rules().map_err(|e| e.to_string())?;
    if rules.is_empty() {
        state
            .repo
            .seed_builtin_rules(&crate::security::rules::builtin_rules_seed(
                chrono::Utc::now().timestamp(),
            ))
            .map_err(|e| e.to_string())?;
        rules = state.repo.list_builtin_rules().map_err(|e| e.to_string())?;
    }
    Ok(rules)
}

#[tauri::command]
pub fn update_builtin_security_rule(
    state: State<AppState>,
    id: String,
    enabled: bool,
    severity: String,
) -> Result<(), String> {
    state
        .repo
        .update_builtin_rule(&id, enabled, &severity)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_builtin_security_rules(state: State<AppState>) -> Result<(), String> {
    state
        .repo
        .reset_builtin_rules(&crate::security::rules::builtin_rules_seed(
            chrono::Utc::now().timestamp(),
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_custom_security_rules(state: State<AppState>) -> Result<Vec<CustomRule>, String> {
    state.repo.list_custom_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_custom_security_rule(
    state: State<AppState>,
    rule_type: String,
    category: String,
    pattern: String,
    severity: String,
    action: String,
    description: Option<String>,
) -> Result<(), String> {
    if !matches!(rule_type.as_str(), "blacklist" | "whitelist") {
        return Err(format!("invalid rule_type: {}", rule_type));
    }
    if !matches!(category.as_str(), "domain" | "tool" | "path" | "keyword") {
        return Err(format!("invalid category: {}", category));
    }
    let r = CustomRule {
        id: uuid::Uuid::new_v4().to_string(),
        rule_type,
        category,
        pattern,
        severity,
        action,
        enabled: true,
        description,
        created_at: chrono::Utc::now().timestamp(),
    };
    state.repo.create_custom_rule(&r).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_custom_security_rule(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .repo
        .set_custom_rule_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_custom_security_rule(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_custom_rule(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_security_findings(
    state: State<AppState>,
    log_id: String,
) -> Result<Vec<RequestSecurityFinding>, String> {
    state.repo.get_findings(&log_id).map_err(|e| e.to_string())
}
