use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

pub mod redact;
pub mod rules;
pub mod scanner;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Clean,
    Info,
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLevel {
    pub fn rank(&self) -> u8 {
        match self {
            RiskLevel::Clean => 0,
            RiskLevel::Info => 1,
            RiskLevel::Low => 2,
            RiskLevel::Medium => 3,
            RiskLevel::High => 4,
            RiskLevel::Critical => 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SecurityAction {
    Allow,
    Warn,
    Redact,
    Block,
}

impl SecurityAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecurityAction::Allow => "allow",
            SecurityAction::Warn => "warn",
            SecurityAction::Redact => "redact",
            SecurityAction::Block => "block",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityFinding {
    pub rule_id: String,
    pub category: String,
    pub severity: RiskLevel,
    pub title: String,
    pub description: Option<String>,
    pub location: String,
    pub evidence_masked: Option<String>,
    pub evidence_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityScanResult {
    pub risk_level: RiskLevel,
    pub risk_score: i64,
    pub action: SecurityAction,
    pub sanitized: bool,
    pub blocked_reason: Option<String>,
    pub summary: String,
    pub findings: Vec<SecurityFinding>,
}

impl Default for SecurityScanResult {
    fn default() -> Self {
        Self {
            risk_level: RiskLevel::Clean,
            risk_score: 0,
            action: SecurityAction::Allow,
            sanitized: false,
            blocked_reason: None,
            summary: String::new(),
            findings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecuritySettings {
    pub enabled: bool,
    pub mode: String,
    pub scan_request: bool,
    pub scan_response: bool,
    pub scan_unicode: bool,
    pub scan_tools: bool,
    pub scan_network: bool,
    pub redact_secrets: bool,
    pub block_on_critical: bool,
    pub max_scan_bytes: usize,
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: "audit".into(),
            scan_request: true,
            scan_response: false,
            scan_unicode: true,
            scan_tools: true,
            scan_network: true,
            redact_secrets: false,
            block_on_critical: false,
            max_scan_bytes: 1024 * 1024,
        }
    }
}

/// Merge store values (a `serde_json::Object` map) into a `SecuritySettings`,
/// keeping defaults for any missing/invalid keys. This is a pure helper so it
/// can be unit-tested without a running Tauri app.
pub fn merge_from_store(mut settings: SecuritySettings, values: &serde_json::Map<String, serde_json::Value>) -> SecuritySettings {
    if let Some(v) = values.get("security.enabled").and_then(|v| v.as_bool()) {
        settings.enabled = v;
    }
    if let Some(v) = values.get("security.mode").and_then(|v| v.as_str()) {
        settings.mode = v.to_string();
    }
    if let Some(v) = values.get("security.scan_request").and_then(|v| v.as_bool()) {
        settings.scan_request = v;
    }
    if let Some(v) = values.get("security.scan_response").and_then(|v| v.as_bool()) {
        settings.scan_response = v;
    }
    if let Some(v) = values.get("security.scan_unicode").and_then(|v| v.as_bool()) {
        settings.scan_unicode = v;
    }
    if let Some(v) = values.get("security.scan_tools").and_then(|v| v.as_bool()) {
        settings.scan_tools = v;
    }
    if let Some(v) = values.get("security.scan_network").and_then(|v| v.as_bool()) {
        settings.scan_network = v;
    }
    if let Some(v) = values.get("security.redact_secrets").and_then(|v| v.as_bool()) {
        settings.redact_secrets = v;
    }
    if let Some(v) = values.get("security.block_on_critical").and_then(|v| v.as_bool()) {
        settings.block_on_critical = v;
    }
    if let Some(v) = values.get("security.max_scan_bytes").and_then(|v| v.as_u64()) {
        settings.max_scan_bytes = v as usize;
    }
    settings
}

/// Read `SecuritySettings` from the tauri-plugin-store file `store.bin`.
/// Missing keys fall back to `SecuritySettings::default()`.
pub fn get_security_settings(app: &tauri::AppHandle) -> SecuritySettings {
    let mut settings = SecuritySettings::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        for key in [
            "security.enabled",
            "security.mode",
            "security.scan_request",
            "security.scan_response",
            "security.scan_unicode",
            "security.scan_tools",
            "security.scan_network",
            "security.redact_secrets",
            "security.block_on_critical",
            "security.max_scan_bytes",
        ] {
            if let Some(value) = store.get(key) {
                values.insert(key.to_string(), value);
            }
        }
        settings = merge_from_store(settings, &values);
    }
    settings
}

/// Apply `SecuritySettings` to the `AppState` security lock.
pub fn apply_settings(state: &crate::proxy::state::AppState, s: &SecuritySettings) {
    *state.security.write().unwrap() = s.clone();
}

pub fn decide_action(result: &mut SecurityScanResult, settings: &SecuritySettings) {
    if !settings.enabled {
        result.action = SecurityAction::Allow;
        return;
    }

    let rank = result.risk_level.rank();
    let mut action = match settings.mode.as_str() {
        "audit" => SecurityAction::Allow,
        "warn" => {
            if rank >= RiskLevel::Medium.rank() {
                SecurityAction::Warn
            } else {
                SecurityAction::Allow
            }
        }
        "redact" => {
            if rank >= RiskLevel::High.rank() {
                SecurityAction::Redact
            } else {
                SecurityAction::Allow
            }
        }
        "block" => {
            if rank >= RiskLevel::High.rank() {
                SecurityAction::Block
            } else {
                SecurityAction::Allow
            }
        }
        _ => SecurityAction::Allow,
    };

    if settings.block_on_critical && result.risk_level == RiskLevel::Critical {
        action = SecurityAction::Block;
    }

    if action == SecurityAction::Block {
        result.blocked_reason = Some(result.summary.clone());
    }

    result.action = action;
}

pub fn scan_request(body: &serde_json::Value, s: &SecuritySettings) -> SecurityScanResult {
    if !s.enabled || !s.scan_request {
        return SecurityScanResult::default();
    }
    let mut result = scanner::scan_json(body, "request", s);
    decide_action(&mut result, s);
    result
}

pub fn scan_response(body: &serde_json::Value, s: &SecuritySettings) -> SecurityScanResult {
    if !s.enabled || !s.scan_response {
        return SecurityScanResult::default();
    }
    let mut result = scanner::scan_json(body, "response", s);
    decide_action(&mut result, s);
    result
}

/// 转发前脱敏入口。返回（可能已脱敏的 body，是否发生了脱敏）。
/// 仅当 `enabled && redact_secrets` 时才会修改 body。
pub fn redact_request_body(body: &serde_json::Value, s: &SecuritySettings) -> (serde_json::Value, bool) {
    let redacted = redact::redact_json(body, s);
    let changed = redacted != *body;
    (redacted, changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn res(level: RiskLevel) -> SecurityScanResult {
        SecurityScanResult {
            risk_level: level,
            risk_score: 0,
            action: SecurityAction::Allow,
            sanitized: false,
            blocked_reason: None,
            summary: "s".into(),
            findings: vec![],
        }
    }
    fn settings(mode: &str, boc: bool) -> SecuritySettings {
        SecuritySettings {
            enabled: true,
            mode: mode.into(),
            block_on_critical: boc,
            ..Default::default()
        }
    }

    #[test]
    fn audit_always_allow() {
        let mut r = res(RiskLevel::Critical);
        decide_action(&mut r, &settings("audit", false));
        assert_eq!(r.action, SecurityAction::Allow);
    }
    #[test]
    fn warn_threshold_medium() {
        let mut lo = res(RiskLevel::Low);
        decide_action(&mut lo, &settings("warn", false));
        assert_eq!(lo.action, SecurityAction::Allow);
        let mut md = res(RiskLevel::Medium);
        decide_action(&mut md, &settings("warn", false));
        assert_eq!(md.action, SecurityAction::Warn);
    }
    #[test]
    fn redact_and_block_threshold_high() {
        let mut md = res(RiskLevel::Medium);
        decide_action(&mut md, &settings("redact", false));
        assert_eq!(md.action, SecurityAction::Allow);
        let mut hi = res(RiskLevel::High);
        decide_action(&mut hi, &settings("redact", false));
        assert_eq!(hi.action, SecurityAction::Redact);
        let mut hi2 = res(RiskLevel::High);
        decide_action(&mut hi2, &settings("block", false));
        assert_eq!(hi2.action, SecurityAction::Block);
        assert!(hi2.blocked_reason.is_some());
    }
    #[test]
    fn block_on_critical_overrides() {
        let mut cr = res(RiskLevel::Critical);
        decide_action(&mut cr, &settings("warn", true));
        assert_eq!(cr.action, SecurityAction::Block);
    }
    #[test]
    fn disabled_allows() {
        let mut r = res(RiskLevel::Critical);
        let mut s = settings("block", true);
        s.enabled = false;
        decide_action(&mut r, &s);
        assert_eq!(r.action, SecurityAction::Allow);
    }

    #[test]
    fn merge_store_overrides_defaults() {
        let mut values = serde_json::Map::new();
        values.insert("security.enabled".into(), serde_json::Value::Bool(false));
        values.insert("security.mode".into(), serde_json::Value::String("block".into()));
        values.insert("security.scan_response".into(), serde_json::Value::Bool(true));
        values.insert("security.max_scan_bytes".into(), serde_json::Value::Number(2048.into()));

        let merged = merge_from_store(SecuritySettings::default(), &values);
        assert!(!merged.enabled);
        assert_eq!(merged.mode, "block");
        assert!(merged.scan_response);
        assert_eq!(merged.max_scan_bytes, 2048);
        // Missing keys keep defaults.
        assert!(merged.scan_request);
    }

    #[test]
    fn merge_store_keeps_defaults_on_missing_keys() {
        let values = serde_json::Map::new();
        let merged = merge_from_store(SecuritySettings::default(), &values);
        assert_eq!(merged, SecuritySettings::default());
    }
}
