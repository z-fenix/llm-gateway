use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

/// RAG 运行时设置:开关、默认知识库、默认 embedding 渠道。
/// 默认关闭,启用后仍需配置 default_kb(或由请求 header `x-kb` 指定)才会注入。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RagSettings {
    pub enabled: bool,
    pub default_kb: Option<String>,
    pub default_embedding_channel: Option<String>,
}

impl Default for RagSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_kb: None,
            default_embedding_channel: None,
        }
    }
}

/// Merge store values (a `serde_json::Object` map) into a `RagSettings`,
/// keeping defaults for any missing/invalid keys. This is a pure helper so it
/// can be unit-tested without a running Tauri app.
pub fn merge_from_store(
    mut settings: RagSettings,
    values: &serde_json::Map<String, serde_json::Value>,
) -> RagSettings {
    if let Some(v) = values.get("rag.enabled").and_then(|v| v.as_bool()) {
        settings.enabled = v;
    }
    if let Some(v) = values.get("rag.default_kb").and_then(|v| v.as_str()) {
        settings.default_kb = Some(v.to_string());
    }
    if let Some(v) = values
        .get("rag.default_embedding_channel")
        .and_then(|v| v.as_str())
    {
        settings.default_embedding_channel = Some(v.to_string());
    }
    settings
}

/// Read `RagSettings` from the tauri-plugin-store file `store.bin`.
/// Missing keys fall back to `RagSettings::default()`.
pub fn get_rag_settings(app: &tauri::AppHandle) -> RagSettings {
    let mut settings = RagSettings::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        for key in [
            "rag.enabled",
            "rag.default_kb",
            "rag.default_embedding_channel",
        ] {
            if let Some(value) = store.get(key) {
                values.insert(key.to_string(), value);
            }
        }
        settings = merge_from_store(settings, &values);
    }
    settings
}

/// Apply `RagSettings` to the `AppState` rag lock.
pub fn apply_settings(state: &crate::proxy::state::AppState, s: &RagSettings) {
    *state.rag.write() = s.clone();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_store_overrides_defaults() {
        let mut values = serde_json::Map::new();
        values.insert("rag.enabled".into(), serde_json::Value::Bool(true));
        values.insert(
            "rag.default_kb".into(),
            serde_json::Value::String("kb1".into()),
        );
        values.insert(
            "rag.default_embedding_channel".into(),
            serde_json::Value::String("ch1".into()),
        );

        let merged = merge_from_store(RagSettings::default(), &values);
        assert!(merged.enabled);
        assert_eq!(merged.default_kb.as_deref(), Some("kb1"));
        assert_eq!(merged.default_embedding_channel.as_deref(), Some("ch1"));
    }

    #[test]
    fn merge_store_keeps_defaults_on_missing_keys() {
        let values = serde_json::Map::new();
        let merged = merge_from_store(RagSettings::default(), &values);
        assert_eq!(merged, RagSettings::default());
    }

    #[test]
    fn default_is_disabled() {
        let s = RagSettings::default();
        assert!(!s.enabled);
        assert!(s.default_kb.is_none());
        assert!(s.default_embedding_channel.is_none());
    }
}
