use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

pub const MIN_PORT: u16 = 8777;
pub const MAX_PORT: u16 = 8787;

/// 应用配置：首选端口（下次启动生效）、关闭时最小化到托盘（默认开启）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    pub preferred_port: u16,
    pub minimize_to_tray: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            preferred_port: 8779,
            minimize_to_tray: true,
        }
    }
}

fn clamp_port(p: u16) -> u16 {
    if (MIN_PORT..=MAX_PORT).contains(&p) {
        p
    } else {
        AppConfig::default().preferred_port
    }
}

pub fn merge_from_store(
    mut c: AppConfig,
    values: &serde_json::Map<String, serde_json::Value>,
) -> AppConfig {
    if let Some(p) = values
        .get("app.preferred_port")
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok())
    {
        c.preferred_port = clamp_port(p);
    }
    if let Some(m) = values.get("app.minimize_to_tray").and_then(|v| v.as_bool()) {
        c.minimize_to_tray = m;
    }
    c
}

pub fn get_app_config(app: &tauri::AppHandle) -> AppConfig {
    let mut c = AppConfig::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        if let Some(v) = store.get("app.preferred_port") {
            values.insert("app.preferred_port".to_string(), v);
        }
        if let Some(v) = store.get("app.minimize_to_tray") {
            values.insert("app.minimize_to_tray".to_string(), v);
        }
        c = merge_from_store(c, &values);
    }
    c
}

pub fn apply_settings(state: &crate::proxy::state::AppState, c: &AppConfig) {
    *state.app.write() = c.clone();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_prefers_store_and_clamps_range() {
        let mut v = serde_json::Map::new();
        v.insert("app.preferred_port".into(), serde_json::json!(8780));
        assert_eq!(
            merge_from_store(AppConfig::default(), &v).preferred_port,
            8780
        );
        // 超出 8777..=8787 → 回落默认 8779
        let mut bad = serde_json::Map::new();
        bad.insert("app.preferred_port".into(), serde_json::json!(9999));
        assert_eq!(
            merge_from_store(AppConfig::default(), &bad).preferred_port,
            8779
        );
    }

    #[test]
    fn merge_keeps_default_on_missing() {
        assert_eq!(
            merge_from_store(AppConfig::default(), &serde_json::Map::new()),
            AppConfig::default()
        );
    }

    #[test]
    fn merge_minimize_to_tray_defaults_and_parses_bool() {
        // 缺省 → true
        assert_eq!(
            merge_from_store(AppConfig::default(), &serde_json::Map::new()).minimize_to_tray,
            true
        );
        // 显式 false → false
        let mut v = serde_json::Map::new();
        v.insert("app.minimize_to_tray".into(), serde_json::json!(false));
        assert_eq!(
            merge_from_store(AppConfig::default(), &v).minimize_to_tray,
            false
        );
        // 显式 true → true
        v.insert("app.minimize_to_tray".into(), serde_json::json!(true));
        assert_eq!(
            merge_from_store(AppConfig::default(), &v).minimize_to_tray,
            true
        );
    }
}
