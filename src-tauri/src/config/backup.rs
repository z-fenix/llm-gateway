use crate::db::models::{ApiKey, BuiltinRule, Channel, CustomRule, RolePattern, RoleRoute};
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FORMAT: &str = "llm-gateway-config";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityExport {
    pub settings: crate::security::SecuritySettings,
    #[serde(default)]
    pub builtin_rules: Vec<BuiltinRule>,
    #[serde(default)]
    pub custom_rules: Vec<CustomRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FallbackExport {
    pub channel_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfigExport {
    pub preferred_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    #[serde(default)]
    pub app_config: Option<AppConfigExport>,
    #[serde(default)]
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub api_keys: Vec<ApiKey>,
    #[serde(default)]
    pub role_routes: Vec<RoleRoute>,
    #[serde(default)]
    pub role_patterns: Vec<RolePattern>,
    #[serde(default)]
    pub fallback: Option<FallbackExport>,
    #[serde(default)]
    pub security: Option<SecurityExport>,
}

/// 汇总导出数据。安全不变量：渠道 api_key 一律置空，绝不外泄。
pub fn build_bundle(state: &AppState) -> Result<ConfigBundle, String> {
    let mut channels = state.repo.list_channels().map_err(|e| e.to_string())?;
    for c in &mut channels {
        c.api_key = String::new(); // 脱敏
    }
    let api_keys = state.repo.list_api_keys().map_err(|e| e.to_string())?;
    let role_routes = state.repo.list_role_routes().map_err(|e| e.to_string())?;
    let role_patterns = state.repo.list_role_patterns().map_err(|e| e.to_string())?;
    let builtin_rules = state.repo.list_builtin_rules().map_err(|e| e.to_string())?;
    let custom_rules = state.repo.list_custom_rules().map_err(|e| e.to_string())?;
    let fallback = state
        .fallback
        .read()
        .clone()
        .map(|(channel_id, model)| FallbackExport { channel_id, model });
    let settings = state.security.read().clone();
    let app_config = Some(AppConfigExport {
        preferred_port: state.app.read().preferred_port,
    });
    Ok(ConfigBundle {
        format: FORMAT.to_string(),
        version: VERSION,
        exported_at: chrono::Utc::now().timestamp(),
        app_config,
        channels,
        api_keys,
        role_routes,
        role_patterns,
        fallback,
        security: Some(SecurityExport {
            settings,
            builtin_rules,
            custom_rules,
        }),
    })
}

pub fn export_to_file(state: &AppState, path: &Path) -> Result<u64, String> {
    let bundle = build_bundle(state)?;
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
    }
    std::fs::write(path, &json).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(json.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Channel;
    use crate::db::Db;
    use crate::proxy::state::AppState;

    fn test_state() -> AppState {
        let state = AppState::new(Db::new_in_memory().unwrap());
        let channel = Channel {
            id: "ch1".into(),
            name: "OpenAI".into(),
            provider_type: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "sk-real-secret".into(),
            models: vec!["gpt-4o".into()],
            priority: 10,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        };
        state.repo.insert_channel(&channel).unwrap();
        state
    }

    #[test]
    fn export_redacts_channel_api_key() {
        let state = test_state();
        let bundle = build_bundle(&state).unwrap();
        assert_eq!(bundle.format, "llm-gateway-config");
        assert_eq!(bundle.version, 1);
        assert_eq!(bundle.channels.len(), 1);
        assert_eq!(bundle.channels[0].api_key, "");
        let json = serde_json::to_string(&bundle).unwrap();
        assert!(!json.contains("sk-real-secret"));
    }
}
