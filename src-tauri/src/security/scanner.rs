//! 纯检测：scan_json 遍历 JSON → 逐字符串跑各类规则；风险评分（Task 3 实现）。

use super::{RiskLevel, SecurityAction, SecurityFinding, SecurityScanResult, SecuritySettings};
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_FINDINGS: usize = 80;

/// 证据脱敏：首尾各保留 3 个字符，中间替换为 ****；过短则整体掩码。
pub fn mask_evidence(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 6 {
        return "****".to_string();
    }
    let first: String = chars.iter().take(3).copied().collect();
    let last: String = chars.iter().rev().take(3).rev().copied().collect();
    format!("{}****{}", first, last)
}

/// 入口：递归扫描 JSON 所有字符串叶子，按设置开启对应检测器。
pub fn scan_json(value: &Value, _phase: &str, s: &SecuritySettings) -> SecurityScanResult {
    let mut findings = Vec::new();
    walk_json(value, "$", s, &mut findings);
    compute_result(findings)
}

fn walk_json(value: &Value, path: &str, s: &SecuritySettings, findings: &mut Vec<SecurityFinding>) {
    if findings.len() >= MAX_FINDINGS {
        return;
    }
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if findings.len() >= MAX_FINDINGS {
                    break;
                }
                // 字段名层面的敏感命名检测
                scan_named_secret_key(k, path, findings);
                let child = if path == "$" {
                    format!("$.{}", k)
                } else {
                    format!("{}.{}", path, k)
                };
                walk_json(v, &child, s, findings);
            }
        }
        Value::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                if findings.len() >= MAX_FINDINGS {
                    break;
                }
                let child = format!("{}[{}]", path, i);
                walk_json(v, &child, s, findings);
            }
        }
        Value::String(text) => {
            scan_string(text, path, s, findings);
        }
        _ => {}
    }
}

/// 将字符串按 `max_scan_bytes` 截断到字符边界，避免扫描超大字符串。
pub(crate) fn truncate_to_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    match text.char_indices().take_while(|(i, _)| *i < max_bytes).last() {
        Some((idx, c)) => &text[..idx + c.len_utf8()],
        None => "",
    }
}

fn scan_string(text: &str, location: &str, s: &SecuritySettings, findings: &mut Vec<SecurityFinding>) {
    let text = truncate_to_bytes(text, s.max_scan_bytes);
    scan_credentials(text, location, findings);
    scan_paths(text, location, findings);
    if s.scan_tools {
        scan_tool_risks(text, location, findings);
    }
    if s.scan_unicode {
        scan_unicode(text, location, findings);
    }
    if s.scan_network {
        scan_network(text, location, findings);
        scan_tracking_pixel(text, location, findings);
    }
    scan_fingerprint_terms(text, location, findings);
    scan_local_path(text, location, findings);
}

fn push_finding(
    findings: &mut Vec<SecurityFinding>,
    category: &str,
    rule_id: &str,
    severity: RiskLevel,
    title: &str,
    location: &str,
    evidence: Option<&str>,
) {
    if findings.len() >= MAX_FINDINGS {
        return;
    }
    findings.push(SecurityFinding {
        rule_id: rule_id.to_string(),
        category: category.to_string(),
        severity,
        title: title.to_string(),
        description: None,
        location: location.to_string(),
        evidence_masked: evidence.map(mask_evidence),
        evidence_hash: None,
    });
}

// ── 1. credential ──────────────────────────────────────────────────────────

fn scan_credentials(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    if detect_secret_token(text) {
        push_finding(
            findings,
            "credential",
            "credential.secret_token",
            RiskLevel::High,
            "检测到疑似 API 密钥或访问令牌",
            location,
            Some(text),
        );
    }
    if detect_private_key(text) {
        push_finding(
            findings,
            "credential",
            "credential.private_key",
            RiskLevel::Critical,
            "检测到 PEM/OpenSSH 私钥",
            location,
            Some(text),
        );
    }
    if detect_named_secret_value(text) {
        push_finding(
            findings,
            "credential",
            "credential.named_secret",
            RiskLevel::High,
            "检测到敏感命名凭据字段",
            location,
            Some(text),
        );
    }
}

fn detect_secret_token(s: &str) -> bool {
    let lower = s.to_lowercase();
    // 前缀均为小写，对 lowercase 后的文本做大小写不敏感匹配。
    let prefixes = [
        "sk-ant-", "ghp_", "gho_", "xoxb-", "akia", "aiza",
    ];
    if prefixes.iter().any(|p| lower.contains(p)) {
        return true;
    }
    if lower.contains("bearer ") {
        return true;
    }
    if s.contains("eyJ") {
        return true;
    }
    // sk- 后跟至少 24 位字母数字
    if let Some(idx) = lower.find("sk-") {
        let after = &s[idx + 3..];
        let count = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .count();
        if count >= 24 {
            return true;
        }
    }
    false
}

fn detect_private_key(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.contains("-----begin") && lower.contains("private key-----")
}

fn detect_named_secret_value(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.contains("authorization:")
        || lower.contains("cookie:")
        || lower.contains("sessionid=")
        || lower.contains("secret_key")
        || lower.contains("access_key")
        || lower.contains("database_url")
}

fn scan_named_secret_key(key: &str, parent: &str, findings: &mut Vec<SecurityFinding>) {
    let lower = key.to_lowercase();
    let names = [
        "authorization",
        "cookie",
        "sessionid",
        "secret_key",
        "access_key",
        "database_url",
    ];
    if names.iter().any(|n| lower.contains(n)) {
        let location = if parent == "$" {
            format!("$.{}", key)
        } else {
            format!("{}.{}", parent, key)
        };
        push_finding(
            findings,
            "credential",
            "credential.named_secret",
            RiskLevel::High,
            "检测到敏感命名凭据字段名",
            &location,
            Some(key),
        );
    }
}

// ── 2. file 敏感路径 ───────────────────────────────────────────────────────

fn scan_paths(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let patterns = [
        ".env",
        "~/.ssh",
        "id_rsa",
        "id_ed25519",
        ".aws/credentials",
        ".git-credentials",
        ".netrc",
        ".npmrc",
        "credentials.json",
    ];
    if patterns.iter().any(|p| text.contains(p)) {
        push_finding(
            findings,
            "file",
            "file.sensitive_path",
            RiskLevel::High,
            "检测到敏感文件路径",
            location,
            Some(text),
        );
    }
}

// ── 3. tool 命令外联 ───────────────────────────────────────────────────────

fn scan_tool_risks(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let lower = text.to_lowercase();
    let read_sensitive = is_read_sensitive(&lower);
    let network_egress = is_network_egress(&lower);

    if read_sensitive && network_egress {
        push_finding(
            findings,
            "tool",
            "tool.shell.exfiltration",
            RiskLevel::Critical,
            "检测到敏感数据读取与网络外联组合，疑似外泄",
            location,
            Some(text),
        );
        return;
    }

    if is_network_or_exec(&lower) {
        push_finding(
            findings,
            "tool",
            "tool.shell.network_or_exec",
            RiskLevel::Medium,
            "检测到网络/命令执行工具调用",
            location,
            Some(text),
        );
    }
}

fn is_network_egress(s: &str) -> bool {
    s.contains("curl")
        || s.contains("wget")
        || s.contains("nc ")
        || s.contains("ncat")
        || s.contains("scp")
        || s.contains("rsync")
}

fn is_network_or_exec(s: &str) -> bool {
    is_network_egress(s)
        || s.contains("bash -c")
        || s.contains("sh -c")
        || s.contains("python -c")
        || s.contains("node -e")
        || s.contains("powershell")
        || s.contains("osascript")
}

fn is_read_sensitive(s: &str) -> bool {
    s.contains("cat .env")
        || s.contains("cat ~/.ssh")
        || s.contains("cat /etc/passwd")
        || s.contains("cat .aws/credentials")
        || s.contains("printenv")
        || s.contains("base64 ~/.ssh")
        || s.contains("env |")
}

// ── 4. unicode 隐写 ────────────────────────────────────────────────────────

fn scan_unicode(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let mut zero_width = false;
    let mut bidi = false;
    let mut variation = false;
    for c in text.chars() {
        match c as u32 {
            0x200B | 0x200C | 0x200D | 0x2060 | 0xFEFF => zero_width = true,
            0x202A..=0x202E | 0x2066..=0x2069 => bidi = true,
            0xFE00..=0xFE0F | 0xE0100..=0xE01EF => variation = true,
            _ => {}
        }
    }
    if zero_width {
        push_finding(
            findings,
            "unicode",
            "unicode.zero_width",
            RiskLevel::Medium,
            "检测到零宽字符隐写",
            location,
            Some(text),
        );
    }
    if bidi {
        push_finding(
            findings,
            "unicode",
            "unicode.bidi_control",
            RiskLevel::High,
            "检测到双向文本覆盖控制字符",
            location,
            Some(text),
        );
    }
    if variation {
        push_finding(
            findings,
            "unicode",
            "unicode.variation_selector",
            RiskLevel::Medium,
            "检测到 Unicode 变体选择符",
            location,
            Some(text),
        );
    }
}

// ── 5. network / html 追踪像素 ─────────────────────────────────────────────

fn scan_network(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let lower = text.to_lowercase();
    let ip_probes = [
        "ifconfig.me",
        "ipinfo.io",
        "ip-api.com",
        "ipify.org",
        "ident.me",
        "icanhazip.com",
        "api.ip.sb",
    ];
    if ip_probes.iter().any(|p| lower.contains(p)) {
        push_finding(
            findings,
            "network",
            "network.ip_probe",
            RiskLevel::High,
            "检测到 IP 探测/外联域名",
            location,
            Some(text),
        );
    }
    let suspicious = [
        "webhook.site",
        "requestbin",
        "ngrok",
        "trycloudflare",
        "pastebin",
        "transfer.sh",
        "file.io",
    ];
    if suspicious.iter().any(|p| lower.contains(p)) {
        push_finding(
            findings,
            "network",
            "network.suspicious_domain",
            RiskLevel::High,
            "检测到可疑外联/暂存域名",
            location,
            Some(text),
        );
    }
    if lower.contains("http://") || lower.contains("https://") {
        push_finding(
            findings,
            "network",
            "network.external_url",
            RiskLevel::Info,
            "检测到外部 URL",
            location,
            Some(text),
        );
    }
}

fn scan_tracking_pixel(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let lower = text.to_lowercase();
    let is_remote_img = lower.contains("<img") && lower.contains("http");
    let has_pixel_feature = lower.contains("1x1")
        || lower.contains("track")
        || lower.contains("pixel")
        || lower.contains("beacon")
        || lower.contains("width=\"1\"")
        || lower.contains("height=\"1\"")
        || lower.contains("width='1'")
        || lower.contains("height='1'");
    if is_remote_img && has_pixel_feature {
        push_finding(
            findings,
            "network",
            "html.tracking_pixel",
            RiskLevel::High,
            "检测到 1x1 / tracking pixel 追踪像素",
            location,
            Some(text),
        );
    }
}

// ── 6. prompt 账号画像 ─────────────────────────────────────────────────────

fn scan_fingerprint_terms(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    let lower = text.to_lowercase();
    let terms = [
        "时区",
        "代理",
        "指纹",
        "风控",
        "隐写",
        "timezone",
        "proxy",
        "fingerprint",
        "steganography",
        "browser",
        "canvas",
        "webgl",
        "user-agent",
        "screen",
        "language",
        "location",
        "vpn",
        "tor",
    ];
    let count = terms.iter().filter(|t| lower.contains(*t)).count();
    if count >= 2 {
        push_finding(
            findings,
            "prompt",
            "prompt.fingerprint_context",
            RiskLevel::Medium,
            "检测到账号/环境指纹探针语境",
            location,
            Some(text),
        );
    }
}

// ── 7. infra 本地路径 ──────────────────────────────────────────────────────

fn scan_local_path(text: &str, location: &str, findings: &mut Vec<SecurityFinding>) {
    if text.contains("/Users/") || text.contains("C:\\Users\\") || text.contains("/home/") {
        push_finding(
            findings,
            "infra",
            "infra.local_path",
            RiskLevel::Medium,
            "检测到本地文件系统路径",
            location,
            Some(text),
        );
    }
}

// ── 评分与摘要 ─────────────────────────────────────────────────────────────

pub(crate) fn compute_result(findings: Vec<SecurityFinding>) -> SecurityScanResult {
    let max_rank = findings.iter().map(|f| f.severity.rank()).max().unwrap_or(0);
    let base_score = match max_rank {
        0 => 0,
        1 => 5,
        2 => 15,
        3 => 35,
        4 => 65,
        5 => 90,
        _ => 0,
    };

    let categories: HashSet<String> = findings.iter().map(|f| f.category.clone()).collect();
    let mut score = base_score;
    if categories.contains("credential") && categories.contains("network") {
        score += 25;
    }
    if categories.contains("file") && categories.contains("network") {
        score += 25;
    }
    if categories.contains("unicode") && categories.contains("network") {
        score += 15;
    }
    if categories.contains("tool") && categories.contains("file") {
        score += 20;
    }
    score = score.min(100);

    let level_from_score = level_from_score(score);
    let level_from_findings = level_from_rank(max_rank);
    let risk_level = if level_from_score.rank() > level_from_findings.rank() {
        level_from_score
    } else {
        level_from_findings
    };

    let summary = summarize(&findings, &risk_level, score);

    SecurityScanResult {
        risk_level,
        risk_score: score,
        action: SecurityAction::Allow,
        sanitized: false,
        blocked_reason: None,
        summary,
        findings,
    }
}

fn level_from_score(score: i64) -> RiskLevel {
    if score >= 90 {
        RiskLevel::Critical
    } else if score >= 65 {
        RiskLevel::High
    } else if score >= 35 {
        RiskLevel::Medium
    } else if score >= 15 {
        RiskLevel::Low
    } else if score >= 5 {
        RiskLevel::Info
    } else {
        RiskLevel::Clean
    }
}

fn level_from_rank(rank: u8) -> RiskLevel {
    match rank {
        0 => RiskLevel::Clean,
        1 => RiskLevel::Info,
        2 => RiskLevel::Low,
        3 => RiskLevel::Medium,
        4 => RiskLevel::High,
        5 => RiskLevel::Critical,
        _ => RiskLevel::Clean,
    }
}

fn summarize(findings: &[SecurityFinding], level: &RiskLevel, score: i64) -> String {
    if findings.is_empty() {
        return "未检测到安全风险。".to_string();
    }
    let categories: HashSet<String> = findings.iter().map(|f| f.category.clone()).collect();
    let top = findings
        .iter()
        .max_by_key(|f| f.severity.rank())
        .map(|f| f.title.as_str())
        .unwrap_or("未知规则");
    let level_str = match level {
        RiskLevel::Clean => "洁净",
        RiskLevel::Info => "信息",
        RiskLevel::Low => "低危",
        RiskLevel::Medium => "中危",
        RiskLevel::High => "高危",
        RiskLevel::Critical => "严重",
    };
    format!(
        "检测到 {} 类风险信号，最高严重级别 {}，综合风险分 {}；最具威胁：{}。",
        categories.len(),
        level_str,
        score,
        top
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> SecuritySettings {
        SecuritySettings {
            enabled: true,
            scan_unicode: true,
            scan_tools: true,
            scan_network: true,
            ..Default::default()
        }
    }

    fn find<'a>(result: &'a SecurityScanResult, rule_id: &str) -> Option<&'a SecurityFinding> {
        result.findings.iter().find(|f| f.rule_id == rule_id)
    }

    #[test]
    fn mask_evidence_masks_middle() {
        let masked = mask_evidence("sk-abcdefghijklmnopqrstuvwxyz");
        assert!(masked.contains("****"));
        assert!(!masked.contains("defghij"));
    }

    #[test]
    fn mask_evidence_short_returns_stars() {
        assert_eq!(mask_evidence("abc"), "****");
    }

    #[test]
    fn scan_credentials_secret_token_hit() {
        let v = json!({"key": "sk-123456789012345678901234" });
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "credential.secret_token").expect("secret token hit");
        assert_eq!(f.severity, RiskLevel::High);
        assert_eq!(f.location, "$.key");
    }

    #[test]
    fn scan_credentials_secret_token_miss() {
        let v = json!({"key": "sk-short"});
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "credential.secret_token").is_none());
    }

    #[test]
    fn scan_credentials_private_key_hit() {
        let v = json!("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "credential.private_key").expect("private key hit");
        assert_eq!(f.severity, RiskLevel::Critical);
    }

    #[test]
    fn scan_credentials_private_key_miss() {
        let v = json!("PUBLIC KEY");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "credential.private_key").is_none());
    }

    #[test]
    fn scan_paths_sensitive_path_hit() {
        let v = json!({"file": ".env"});
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "file.sensitive_path").expect("sensitive path hit");
        assert_eq!(f.severity, RiskLevel::High);
    }

    #[test]
    fn scan_paths_sensitive_path_miss() {
        let v = json!("safe.txt");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "file.sensitive_path").is_none());
    }

    #[test]
    fn scan_unicode_zero_width_hit() {
        let v = json!({"t": "隐\u{200B}写"});
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "unicode.zero_width").expect("zero-width hit");
        assert_eq!(f.severity, RiskLevel::Medium);
    }

    #[test]
    fn scan_unicode_zero_width_miss() {
        let v = json!("隐形");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "unicode.zero_width").is_none());
    }

    #[test]
    fn scan_unicode_bidi_hit() {
        let v = json!({"t": "\u{202E}payload"});
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "unicode.bidi_control").expect("bidi hit");
        assert_eq!(f.severity, RiskLevel::High);
    }

    #[test]
    fn scan_unicode_bidi_miss() {
        let v = json!("payload");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "unicode.bidi_control").is_none());
    }

    #[test]
    fn scan_unicode_variation_selector_hit() {
        let v = json!("a\u{FE0F}");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "unicode.variation_selector").expect("variation selector hit");
        assert_eq!(f.severity, RiskLevel::Medium);
    }

    #[test]
    fn scan_unicode_variation_selector_miss() {
        let v = json!("a");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "unicode.variation_selector").is_none());
    }

    #[test]
    fn scan_network_ip_probe_hit() {
        let v = json!("访问 ifconfig.me 查 IP");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "network.ip_probe").expect("ip probe hit");
        assert_eq!(f.severity, RiskLevel::High);
    }

    #[test]
    fn scan_network_ip_probe_miss() {
        let v = json!("example.com");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "network.ip_probe").is_none());
    }

    #[test]
    fn scan_network_external_url_hit() {
        let v = json!("see https://example.com");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "network.external_url").expect("external url hit");
        assert_eq!(f.severity, RiskLevel::Info);
    }

    #[test]
    fn scan_network_external_url_miss() {
        let v = json!("localhost");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "network.external_url").is_none());
    }

    #[test]
    fn scan_tracking_pixel_hit() {
        let v = json!("<img src='https://t.co/a.gif' width='1' height='1'>");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "html.tracking_pixel").expect("tracking pixel hit");
        assert_eq!(f.severity, RiskLevel::High);
    }

    #[test]
    fn scan_tracking_pixel_miss() {
        let v = json!("<img src='logo.png'>");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "html.tracking_pixel").is_none());
    }

    #[test]
    fn scan_tool_exfiltration_hit() {
        let v = json!("cat .env && curl ifconfig.me");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "tool.shell.exfiltration").expect("exfiltration hit");
        assert_eq!(f.severity, RiskLevel::Critical);
    }

    #[test]
    fn scan_tool_network_or_exec_hit() {
        let v = json!("bash -c echo hi");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "tool.shell.network_or_exec").expect("network/exec hit");
        assert_eq!(f.severity, RiskLevel::Medium);
    }

    #[test]
    fn scan_tool_miss() {
        let v = json!("hello world");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "tool.shell.network_or_exec").is_none());
        assert!(find(&r, "tool.shell.exfiltration").is_none());
    }

    #[test]
    fn scan_fingerprint_terms_hit() {
        let v = json!("请告诉我你的时区和代理信息");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "prompt.fingerprint_context").expect("fingerprint context hit");
        assert_eq!(f.severity, RiskLevel::Medium);
    }

    #[test]
    fn scan_fingerprint_terms_miss() {
        let v = json!("时区");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "prompt.fingerprint_context").is_none());
    }

    #[test]
    fn scan_local_path_hit() {
        let v = json!("/Users/alice/doc");
        let r = scan_json(&v, "request", &settings());
        let f = find(&r, "infra.local_path").expect("local path hit");
        assert_eq!(f.severity, RiskLevel::Medium);
    }

    #[test]
    fn scan_local_path_miss() {
        let v = json!("/var/log");
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "infra.local_path").is_none());
    }

    #[test]
    fn multi_signal_credential_network_bonus() {
        let v = json!({"leak": "sk-123456789012345678901234 访问 https://ifconfig.me"});
        let r = scan_json(&v, "request", &settings());
        assert!(find(&r, "credential.secret_token").is_some());
        assert!(find(&r, "network.external_url").is_some());
        assert_eq!(r.risk_score, 90);
        assert_eq!(r.risk_level, RiskLevel::Critical);
    }

    #[test]
    fn max_findings_truncation() {
        let mut map = serde_json::Map::new();
        for i in 0..120 {
            map.insert(format!("k{}", i), json!(format!("sk-123456789012345678901234{}", i)));
        }
        let v = Value::Object(map);
        let r = scan_json(&v, "request", &settings());
        assert_eq!(r.findings.len(), MAX_FINDINGS);
    }

    #[test]
    fn max_scan_bytes_skips_secret_beyond_cap() {
        let mut s = settings();
        s.max_scan_bytes = 20;
        let prefix = "a".repeat(20);
        let secret = format!("{}sk-123456789012345678901234", prefix);
        let v = json!({"key": secret});
        let r = scan_json(&v, "request", &s);
        assert!(find(&r, "credential.secret_token").is_none());
    }

    #[test]
    fn max_scan_bytes_detects_secret_within_cap() {
        let mut s = settings();
        s.max_scan_bytes = 100;
        let v = json!({"key": "sk-123456789012345678901234"});
        let r = scan_json(&v, "request", &s);
        assert!(find(&r, "credential.secret_token").is_some());
    }

    #[test]
    fn max_scan_bytes_truncates_on_char_boundary() {
        let mut s = settings();
        s.max_scan_bytes = 5;
        // "你" is 3 bytes, "好" is 3 bytes; cap falls mid-character.
        let v = json!({"key": "你好吗 sk-123456789012345678901234"});
        let r = scan_json(&v, "request", &s);
        assert!(find(&r, "credential.secret_token").is_none());
    }
}
