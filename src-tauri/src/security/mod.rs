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

    /// 严格度排序：Allow < Warn < Redact < Block。
    pub fn rank(&self) -> u8 {
        match self {
            SecurityAction::Allow => 0,
            SecurityAction::Warn => 1,
            SecurityAction::Redact => 2,
            SecurityAction::Block => 3,
        }
    }
}

/// 解析规则 action 字符串（大小写不敏感）为 `SecurityAction`。
/// 空串或未知值返回 `None`。
pub fn parse_rule_action(s: &str) -> Option<SecurityAction> {
    match s.to_lowercase().as_str() {
        "block" => Some(SecurityAction::Block),
        "redact" => Some(SecurityAction::Redact),
        "warn" => Some(SecurityAction::Warn),
        "allow" => Some(SecurityAction::Allow),
        _ => None,
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
    #[serde(default)]
    pub action: Option<SecurityAction>,
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
pub fn merge_from_store(
    mut settings: SecuritySettings,
    values: &serde_json::Map<String, serde_json::Value>,
) -> SecuritySettings {
    if let Some(v) = values.get("security.enabled").and_then(|v| v.as_bool()) {
        settings.enabled = v;
    }
    if let Some(v) = values.get("security.mode").and_then(|v| v.as_str()) {
        settings.mode = v.to_string();
    }
    if let Some(v) = values
        .get("security.scan_request")
        .and_then(|v| v.as_bool())
    {
        settings.scan_request = v;
    }
    if let Some(v) = values
        .get("security.scan_response")
        .and_then(|v| v.as_bool())
    {
        settings.scan_response = v;
    }
    if let Some(v) = values
        .get("security.scan_unicode")
        .and_then(|v| v.as_bool())
    {
        settings.scan_unicode = v;
    }
    if let Some(v) = values.get("security.scan_tools").and_then(|v| v.as_bool()) {
        settings.scan_tools = v;
    }
    if let Some(v) = values
        .get("security.scan_network")
        .and_then(|v| v.as_bool())
    {
        settings.scan_network = v;
    }
    if let Some(v) = values
        .get("security.redact_secrets")
        .and_then(|v| v.as_bool())
    {
        settings.redact_secrets = v;
    }
    if let Some(v) = values
        .get("security.block_on_critical")
        .and_then(|v| v.as_bool())
    {
        settings.block_on_critical = v;
    }
    if let Some(v) = values
        .get("security.max_scan_bytes")
        .and_then(|v| v.as_u64())
    {
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
    *state.security.write() = s.clone();
}

pub fn decide_action(result: &mut SecurityScanResult, settings: &SecuritySettings) {
    result.blocked_reason = None; // 复位，仅 Block 时重设

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
        other => {
            log::warn!("unknown security mode {:?}, falling back to Allow", other);
            SecurityAction::Allow
        }
    };

    if settings.block_on_critical && result.risk_level == RiskLevel::Critical {
        action = SecurityAction::Block;
    }

    if action == SecurityAction::Block {
        result.blocked_reason = Some(result.summary.clone());
    }

    result.action = action;
}

/// 自定义规则 action 参与最终动作决策：遍历存活的 findings，
/// 取全局 mode 动作与所有命中规则 action 中较严者（Allow<Warn<Redact<Block）。
/// 纯函数，便于单元测试；`run_scan_with_custom` 在 whitelist 抑制后调用它，
/// 因此被白名单抑制的 finding 不会参与升级。
pub fn escalate_with_custom_actions(result: &mut SecurityScanResult) {
    let mut best = result.action.rank();
    let mut blocking_finding: Option<&SecurityFinding> = None;
    for f in &result.findings {
        if let Some(ref action) = f.action {
            let r = action.rank();
            if r > best {
                best = r;
                if r == SecurityAction::Block.rank() {
                    blocking_finding = Some(f);
                }
            }
        }
    }
    let action = match best {
        3 => SecurityAction::Block,
        2 => SecurityAction::Redact,
        1 => SecurityAction::Warn,
        _ => SecurityAction::Allow,
    };
    // 仅当规则 action 把动作升级到 Block 时，用命中规则标题填充 blocked_reason；
    // 若 Block 本就来自全局模式，保留 decide_action 已设置的值。
    if action == SecurityAction::Block {
        if let Some(f) = blocking_finding {
            result.blocked_reason = Some(f.title.clone());
        }
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
pub fn redact_request_body(
    body: &serde_json::Value,
    s: &SecuritySettings,
) -> (serde_json::Value, bool) {
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
    fn decide_action_clears_stale_blocked_reason_on_non_block() {
        let mut r = SecurityScanResult {
            blocked_reason: Some("stale".into()),
            ..Default::default()
        };
        let s = SecuritySettings {
            mode: "audit".into(),
            ..Default::default()
        };
        decide_action(&mut r, &s);
        assert_eq!(r.action, SecurityAction::Allow);
        assert!(r.blocked_reason.is_none(), "stale blocked_reason 应被清除");
    }

    #[test]
    fn decide_action_unknown_mode_falls_back_allow() {
        let mut r = SecurityScanResult::default();
        let s = SecuritySettings {
            mode: "bogus".into(),
            ..Default::default()
        };
        decide_action(&mut r, &s);
        assert_eq!(r.action, SecurityAction::Allow);
    }

    #[test]
    fn merge_store_overrides_defaults() {
        let mut values = serde_json::Map::new();
        values.insert("security.enabled".into(), serde_json::Value::Bool(false));
        values.insert(
            "security.mode".into(),
            serde_json::Value::String("block".into()),
        );
        values.insert(
            "security.scan_response".into(),
            serde_json::Value::Bool(true),
        );
        values.insert(
            "security.max_scan_bytes".into(),
            serde_json::Value::Number(2048.into()),
        );

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

    fn finding_with_action(action: Option<SecurityAction>) -> SecurityFinding {
        SecurityFinding {
            rule_id: "custom.blacklist.keyword".into(),
            category: "keyword".into(),
            severity: RiskLevel::Medium,
            title: "自定义黑名单命中：keyword".into(),
            description: None,
            location: "$.msg".into(),
            evidence_masked: None,
            evidence_hash: None,
            action,
        }
    }

    #[test]
    fn parse_rule_action_parses_known_values_case_insensitive() {
        assert_eq!(parse_rule_action("block"), Some(SecurityAction::Block));
        assert_eq!(parse_rule_action("BLOCK"), Some(SecurityAction::Block));
        assert_eq!(parse_rule_action("Redact"), Some(SecurityAction::Redact));
        assert_eq!(parse_rule_action("warn"), Some(SecurityAction::Warn));
        assert_eq!(parse_rule_action("allow"), Some(SecurityAction::Allow));
        assert_eq!(parse_rule_action(""), None);
        assert_eq!(parse_rule_action("bogus"), None);
    }

    #[test]
    fn action_rank_order_is_allow_warn_redact_block() {
        assert!(SecurityAction::Allow.rank() < SecurityAction::Warn.rank());
        assert!(SecurityAction::Warn.rank() < SecurityAction::Redact.rank());
        assert!(SecurityAction::Redact.rank() < SecurityAction::Block.rank());
    }

    #[test]
    fn escalate_audit_mode_block_rule_blocks() {
        let mut r = res(RiskLevel::Critical);
        r.action = SecurityAction::Allow;
        r.summary = "global summary".into();
        r.findings = vec![finding_with_action(Some(SecurityAction::Block))];
        escalate_with_custom_actions(&mut r);
        assert_eq!(r.action, SecurityAction::Block);
        assert_eq!(
            r.blocked_reason.as_deref(),
            Some("自定义黑名单命中：keyword"),
            "blocked_reason 应取命中规则标题"
        );
    }

    #[test]
    fn escalate_audit_mode_warn_rule_warns() {
        let mut r = res(RiskLevel::Critical);
        r.action = SecurityAction::Allow;
        r.findings = vec![finding_with_action(Some(SecurityAction::Warn))];
        escalate_with_custom_actions(&mut r);
        assert_eq!(r.action, SecurityAction::Warn);
        assert!(r.blocked_reason.is_none());
    }

    #[test]
    fn escalate_global_block_keeps_block_over_rule_warn() {
        let mut r = res(RiskLevel::High);
        r.action = SecurityAction::Block;
        r.blocked_reason = Some("from global".into());
        r.findings = vec![finding_with_action(Some(SecurityAction::Warn))];
        escalate_with_custom_actions(&mut r);
        // 全局 block 比规则 warn 更严，保持 Block。
        assert_eq!(r.action, SecurityAction::Block);
        assert_eq!(r.blocked_reason.as_deref(), Some("from global"));
    }

    #[test]
    fn escalate_no_rule_action_keeps_global() {
        let mut r = res(RiskLevel::High);
        r.action = SecurityAction::Warn;
        r.findings = vec![
            finding_with_action(None),
            finding_with_action(Some(SecurityAction::Allow)),
        ];
        escalate_with_custom_actions(&mut r);
        assert_eq!(r.action, SecurityAction::Warn);
    }

    #[test]
    fn escalate_suppressed_finding_does_not_apply() {
        // 模拟白名单抑制后的结果：findings 为空（被过滤），不应升级。
        let mut r = res(RiskLevel::Clean);
        r.action = SecurityAction::Allow;
        r.findings = vec![];
        escalate_with_custom_actions(&mut r);
        assert_eq!(r.action, SecurityAction::Allow);
        assert!(r.blocked_reason.is_none());
    }
}
