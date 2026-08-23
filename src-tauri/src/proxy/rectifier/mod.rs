//! Anthropic 兼容性整流器配置（镜像 cc-switch RectifierConfig）。

use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RectifierConfig {
    pub enabled: bool,
    pub request_thinking_signature: bool,
    pub request_thinking_budget: bool,
    pub request_media_fallback: bool,
    pub request_media_heuristic: bool,
}

impl Default for RectifierConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            request_thinking_signature: true,
            request_thinking_budget: true,
            request_media_fallback: true,
            request_media_heuristic: true,
        }
    }
}

/// 将 store 值合并进配置，缺省键保持默认。纯函数便于单测。
pub fn merge_from_store(
    mut c: RectifierConfig,
    values: &serde_json::Map<String, serde_json::Value>,
) -> RectifierConfig {
    if let Some(v) = values.get("rectifier.enabled").and_then(|v| v.as_bool()) {
        c.enabled = v;
    }
    if let Some(v) = values.get("rectifier.request_thinking_signature").and_then(|v| v.as_bool()) {
        c.request_thinking_signature = v;
    }
    if let Some(v) = values.get("rectifier.request_thinking_budget").and_then(|v| v.as_bool()) {
        c.request_thinking_budget = v;
    }
    if let Some(v) = values.get("rectifier.request_media_fallback").and_then(|v| v.as_bool()) {
        c.request_media_fallback = v;
    }
    if let Some(v) = values.get("rectifier.request_media_heuristic").and_then(|v| v.as_bool()) {
        c.request_media_heuristic = v;
    }
    c
}

/// 从 store.bin 读取整流器配置，缺省用默认值。
pub fn get_rectifier_config(app: &tauri::AppHandle) -> RectifierConfig {
    let mut c = RectifierConfig::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        for key in [
            "rectifier.enabled",
            "rectifier.request_thinking_signature",
            "rectifier.request_thinking_budget",
            "rectifier.request_media_fallback",
            "rectifier.request_media_heuristic",
        ] {
            if let Some(v) = store.get(key) {
                values.insert(key.to_string(), v);
            }
        }
        c = merge_from_store(c, &values);
    }
    c
}

/// 写整流器配置到 AppState。
pub fn apply_settings(state: &AppState, c: &RectifierConfig) {
    *state.rectifier.write() = c.clone();
}

pub mod thinking_signature;
pub mod thinking_budget;
pub mod media;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_all_true() {
        let c = RectifierConfig::default();
        assert!(c.enabled && c.request_thinking_signature && c.request_thinking_budget
            && c.request_media_fallback && c.request_media_heuristic);
    }

    #[test]
    fn merge_overrides_and_keeps_defaults() {
        let mut values = serde_json::Map::new();
        values.insert("rectifier.enabled".into(), serde_json::Value::Bool(false));
        let merged = merge_from_store(RectifierConfig::default(), &values);
        assert!(!merged.enabled);
        assert!(merged.request_thinking_signature); // 缺省键保持 true
    }

    #[test]
    fn merge_empty_keeps_defaults() {
        let merged = merge_from_store(RectifierConfig::default(), &serde_json::Map::new());
        assert_eq!(merged, RectifierConfig::default());
    }
}
