use serde::{Deserialize, Serialize};

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
}
