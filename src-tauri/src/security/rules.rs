//! 内置规则 seed + 自定义黑白名单匹配（Task 5 实现）。

use super::scanner::mask_evidence;
use super::RiskLevel;
use super::SecurityFinding;
use crate::db::models::{BuiltinRule, CustomRule};

/// 内置规则元数据：`(rule_id, category, severity, title, toggle_key)`。
/// toggle_key 为空字符串表示始终启用；其余对应 `SecuritySettings` 中的开关。
pub const BUILTIN_RULES: &[(&str, &str, &str, &str, &str)] = &[
    // credential
    (
        "credential.secret_token",
        "credential",
        "high",
        "检测到疑似 API 密钥或访问令牌",
        "",
    ),
    (
        "credential.private_key",
        "credential",
        "critical",
        "检测到 PEM/OpenSSH 私钥",
        "",
    ),
    (
        "credential.named_secret",
        "credential",
        "high",
        "检测到敏感命名凭据字段",
        "",
    ),
    // file
    (
        "file.sensitive_path",
        "file",
        "high",
        "检测到敏感文件路径",
        "",
    ),
    // tool
    (
        "tool.shell.network_or_exec",
        "tool",
        "medium",
        "检测到网络/命令执行工具调用",
        "scan_tools",
    ),
    (
        "tool.shell.exfiltration",
        "tool",
        "critical",
        "检测到敏感数据读取与网络外联组合，疑似外泄",
        "scan_tools",
    ),
    // unicode
    (
        "unicode.zero_width",
        "unicode",
        "medium",
        "检测到零宽字符隐写",
        "scan_unicode",
    ),
    (
        "unicode.bidi_control",
        "unicode",
        "high",
        "检测到双向文本覆盖控制字符",
        "scan_unicode",
    ),
    (
        "unicode.variation_selector",
        "unicode",
        "medium",
        "检测到 Unicode 变体选择符",
        "scan_unicode",
    ),
    // network / html
    (
        "html.tracking_pixel",
        "network",
        "high",
        "检测到 1x1 / tracking pixel 追踪像素",
        "scan_network",
    ),
    (
        "network.ip_probe",
        "network",
        "high",
        "检测到 IP 探测/外联域名",
        "scan_network",
    ),
    (
        "network.suspicious_domain",
        "network",
        "high",
        "检测到可疑外联/暂存域名",
        "scan_network",
    ),
    (
        "network.external_url",
        "network",
        "info",
        "检测到外部 URL",
        "scan_network",
    ),
    // prompt
    (
        "prompt.fingerprint_context",
        "prompt",
        "medium",
        "检测到账号/环境指纹探针语境",
        "",
    ),
    // infra
    (
        "infra.local_path",
        "infra",
        "medium",
        "检测到本地文件系统路径",
        "",
    ),
];

/// 将 `BUILTIN_RULES` 转换为可写入数据库的完整 `BuiltinRule` 结构。
/// `created_at` 由调用方/DB 层提供，避免在纯 seed 函数中依赖系统时间。
pub fn builtin_rules_seed(created_at: i64) -> Vec<BuiltinRule> {
    BUILTIN_RULES
        .iter()
        .map(|(rule_id, category, severity, title, toggle_key)| BuiltinRule {
            id: rule_id.replace('.', "_"),
            rule_id: (*rule_id).to_string(),
            category: (*category).to_string(),
            severity: (*severity).to_string(),
            title: (*title).to_string(),
            description: None,
            toggle_key: if toggle_key.is_empty() {
                None
            } else {
                Some((*toggle_key).to_string())
            },
            enabled: true,
            created_at,
        })
        .collect()
}

fn parse_risk_level(s: &str) -> RiskLevel {
    match s.to_lowercase().as_str() {
        "clean" => RiskLevel::Clean,
        "info" => RiskLevel::Info,
        "low" => RiskLevel::Low,
        "medium" => RiskLevel::Medium,
        "high" => RiskLevel::High,
        "critical" => RiskLevel::Critical,
        _ => RiskLevel::Medium,
    }
}

const VALID_CUSTOM_CATEGORIES: &[&str] = &["domain", "tool", "path", "keyword"];

fn category_matches(rule_category: &str) -> bool {
    VALID_CUSTOM_CATEGORIES
        .iter()
        .any(|c| c.eq_ignore_ascii_case(rule_category))
}

/// 对给定文本应用启用状态的自定义黑名单规则，命中则追加到 `findings`。
pub fn apply_custom_rules(
    text: &str,
    _phase: &str,
    location: &str,
    rules: &[CustomRule],
    findings: &mut Vec<SecurityFinding>,
) {
    let text_lower = text.to_lowercase();
    for rule in rules.iter().filter(|r| r.enabled && r.rule_type == "blacklist") {
        if !category_matches(&rule.category) {
            continue;
        }
        if text_lower.contains(&rule.pattern.to_lowercase()) {
            findings.push(SecurityFinding {
                rule_id: format!("custom.{}.{}", rule.rule_type, rule.category),
                category: rule.category.clone(),
                severity: parse_risk_level(&rule.severity),
                title: format!("自定义黑名单命中：{}", rule.category),
                description: rule.description.clone(),
                location: location.to_string(),
                evidence_masked: Some(mask_evidence(text)),
                evidence_hash: None,
            });
        }
    }
}

/// 判断给定类别和值是否被自定义白名单规则放行。
pub fn is_whitelisted(category: &str, value: &str, rules: &[CustomRule]) -> bool {
    if !category_matches(category) {
        return false;
    }
    let value_lower = value.to_lowercase();
    rules
        .iter()
        .filter(|r| r.enabled && r.rule_type == "whitelist")
        .any(|r| {
            r.category.eq_ignore_ascii_case(category)
                && value_lower.contains(&r.pattern.to_lowercase())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_rule(
        rule_type: &str,
        category: &str,
        pattern: &str,
        severity: &str,
        enabled: bool,
    ) -> CustomRule {
        CustomRule {
            id: format!("{}_{}_{}", rule_type, category, pattern),
            rule_type: rule_type.to_string(),
            category: category.to_string(),
            pattern: pattern.to_string(),
            severity: severity.to_string(),
            action: "block".to_string(),
            enabled,
            description: None,
            created_at: 0,
        }
    }

    #[test]
    fn blacklist_domain_substring_hit() {
        let rules = vec![custom_rule("blacklist", "domain", "evil.com", "high", true)];
        let mut findings = Vec::new();
        apply_custom_rules(
            "visit https://evil.com/path",
            "request",
            "$.url",
            &rules,
            &mut findings,
        );
        assert_eq!(findings.len(), 1);
        let f = &findings[0];
        assert_eq!(f.rule_id, "custom.blacklist.domain");
        assert_eq!(f.severity, RiskLevel::High);
        assert_eq!(f.category, "domain");
        assert_eq!(f.location, "$.url");
        assert!(f.evidence_masked.is_some());
    }

    #[test]
    fn blacklist_disabled_rule_skipped() {
        let rules = vec![custom_rule("blacklist", "domain", "evil.com", "high", false)];
        let mut findings = Vec::new();
        apply_custom_rules(
            "visit https://evil.com/path",
            "request",
            "$.url",
            &rules,
            &mut findings,
        );
        assert!(findings.is_empty());
    }

    #[test]
    fn blacklist_invalid_category_does_not_match() {
        let rules = vec![custom_rule("blacklist", "emoji", "💣", "medium", true)];
        let mut findings = Vec::new();
        apply_custom_rules("💣", "request", "$.text", &rules, &mut findings);
        assert!(findings.is_empty());
    }

    #[test]
    fn whitelist_hit() {
        let rules = vec![custom_rule("whitelist", "domain", "trusted.org", "info", true)];
        assert!(is_whitelisted("domain", "https://trusted.org/api", &rules));
    }

    #[test]
    fn whitelist_case_insensitive() {
        let rules = vec![custom_rule("whitelist", "path", "SafeDir", "info", true)];
        assert!(is_whitelisted("path", "/user/safedir/file", &rules));
    }

    #[test]
    fn whitelist_disabled_rule_skipped() {
        let rules = vec![custom_rule("whitelist", "domain", "trusted.org", "info", false)];
        assert!(!is_whitelisted("domain", "https://trusted.org/api", &rules));
    }

    #[test]
    fn whitelist_invalid_category_returns_false() {
        let rules = vec![custom_rule("whitelist", "emoji", "💣", "info", true)];
        assert!(!is_whitelisted("emoji", "💣", &rules));
    }

    #[test]
    fn parse_severity_unknown_defaults_to_medium() {
        assert_eq!(parse_risk_level("unknown"), RiskLevel::Medium);
        assert_eq!(parse_risk_level("MEDIUM"), RiskLevel::Medium);
        assert_eq!(parse_risk_level("critical"), RiskLevel::Critical);
    }

    #[test]
    fn builtin_rules_seed_covers_all_15_rule_ids() {
        let seed = builtin_rules_seed(0);
        assert_eq!(seed.len(), 15);
        let ids: Vec<_> = seed.iter().map(|r| r.rule_id.clone()).collect();
        for (rule_id, _, _, _, _) in BUILTIN_RULES.iter() {
            assert!(
                ids.contains(&rule_id.to_string()),
                "missing builtin rule {}",
                rule_id
            );
        }
        assert!(seed.iter().all(|r| r.enabled));
    }
}
