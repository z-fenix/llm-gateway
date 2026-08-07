//! redact_json(转发前) / redact_json_for_logging(落库前)；证据掩码（Task 4 实现）。

use super::scanner::mask_evidence;
use super::SecuritySettings;
use serde_json::{Map, Value};

/// 转发路径脱敏：仅当安全功能启用且开启 `redact_secrets` 时才修改请求体。
pub fn redact_json(value: &Value, s: &SecuritySettings) -> Value {
    if s.enabled && s.redact_secrets {
        redact_value(value)
    } else {
        value.clone()
    }
}

/// 落库路径脱敏：无条件打码，确保日志/持久化请求体中永远不会出现明文密钥。
/// 与转发路径解耦：即使 audit 模式放行原始请求，落库时仍脱敏。
pub fn redact_json_for_logging(value: &Value) -> Value {
    redact_value(value)
}

/// 递归打码 JSON 值。
fn redact_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (k, v) in map {
                let redacted_v = if is_secret_field(k) {
                    match v {
                        Value::String(s) => Value::String(mask_string(s)),
                        other => Value::String(mask_string(&other.to_string())),
                    }
                } else {
                    redact_value(v)
                };
                out.insert(k.clone(), redacted_v);
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(redact_value).collect()),
        Value::String(s) => Value::String(redact_string(s)),
        other => other.clone(),
    }
}

/// 敏感字段名：命中后整体打码其字符串值。
pub fn is_secret_field(key: &str) -> bool {
    let lower = key.to_lowercase();
    [
        "authorization",
        "cookie",
        "sessionid",
        "secret_key",
        "access_key",
        "database_url",
    ]
    .iter()
    .any(|name| lower.contains(name))
}

/// 整体字符串打码（复用证据掩码逻辑）。
pub fn mask_string(s: &str) -> String {
    mask_evidence(s)
}

/// 对单个字符串中的各类密钥/token 进行打码。
pub fn redact_string(s: &str) -> String {
    let s = redact_pem(s);
    let s = redact_bearer(&s);
    let s = redact_prefix_token(&s, "gho_", "gho_****");
    let s = redact_prefix_token(&s, "xoxb-", "xoxb-****");
    let s = redact_sk_family(&s);
    let s = redact_prefix_token(&s, "ghp_", "ghp_****");
    let s = redact_prefix_token(&s, "AKIA", "AKIA****");
    let s = redact_prefix_token(&s, "akia", "akia****");
    let s = redact_prefix_token(&s, "AIza", "AIza****");
    let s = redact_prefix_token(&s, "aiza", "aiza****");
    redact_jwt(&s)
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// 同时处理 `sk-ant-` 与通用 `sk-` token，避免通用规则部分掩码 `sk-ant-****`。
fn redact_sk_family(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let sk_ant: Vec<char> = "sk-ant-".chars().collect();
    let sk: Vec<char> = "sk-".chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + sk_ant.len() <= chars.len()
            && chars[i..i + sk_ant.len()] == sk_ant[..]
        {
            let mut j = i + sk_ant.len();
            while j < chars.len() && is_token_char(chars[j]) {
                j += 1;
            }
            result.push_str("sk-ant-****");
            i = j;
        } else if i + sk.len() <= chars.len()
            && chars[i..i + sk.len()] == sk[..]
        {
            let mut j = i + sk.len();
            while j < chars.len() && is_token_char(chars[j]) {
                j += 1;
            }
            result.push_str("sk-****");
            i = j;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

fn is_bearer_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=')
}

fn is_jwt_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '='
}

/// 按固定前缀识别 token 并替换为保留前缀的掩码形式。
fn redact_prefix_token(s: &str, prefix: &str, replacement: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let prefix_chars: Vec<char> = prefix.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + prefix_chars.len() <= chars.len()
            && chars[i..i + prefix_chars.len()] == prefix_chars[..]
        {
            let mut j = i + prefix_chars.len();
            while j < chars.len() && is_token_char(chars[j]) {
                j += 1;
            }
            result.push_str(replacement);
            i = j;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

/// Bearer token：保留 "Bearer " 与前两位，后续替换为 ****。
fn redact_bearer(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let prefix: Vec<char> = "bearer ".chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + prefix.len() <= chars.len()
            && chars[i..i + prefix.len()]
                .iter()
                .zip(&prefix)
                .all(|(a, b)| a.to_ascii_lowercase() == *b)
        {
            let start = i + prefix.len();
            let mut j = start;
            while j < chars.len() && is_bearer_token_char(chars[j]) {
                j += 1;
            }
            let kept_len = (start + 2).min(j) - start;
            let kept: String = chars[start..start + kept_len].iter().collect();
            // 保留原始大小写 scheme
            for c in &chars[i..i + prefix.len()] {
                result.push(*c);
            }
            result.push_str(&kept);
            result.push_str("****");
            i = j;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

/// JWT（eyJ...）：保留前缀并掩码。
fn redact_jwt(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let prefix: Vec<char> = "eyJ".chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if i + prefix.len() <= chars.len() && chars[i..i + prefix.len()] == prefix[..] {
            let mut j = i + prefix.len();
            while j < chars.len() && is_jwt_char(chars[j]) {
                j += 1;
            }
            result.push_str("eyJ****");
            i = j;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

/// PEM/OpenSSH 私钥：整块替换为 `[REDACTED PRIVATE KEY]`，去掉 base64 body。
fn redact_pem(s: &str) -> String {
    let lines: Vec<&str> = s.split_inclusive('\n').collect();
    let mut result = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let lower = lines[i].to_lowercase();
        if lower.contains("-----begin") && lower.contains("private key-----") {
            let mut j = i + 1;
            let mut found_end = false;
            while j < lines.len() {
                let lower_j = lines[j].to_lowercase();
                if lower_j.contains("-----end") && lower_j.contains("private key-----") {
                    found_end = true;
                    break;
                }
                j += 1;
            }
            let placeholder = if found_end {
                if lines[j].ends_with('\n') {
                    "[REDACTED PRIVATE KEY]\n"
                } else {
                    "[REDACTED PRIVATE KEY]"
                }
            } else if lines[i].ends_with('\n') {
                "[REDACTED PRIVATE KEY]\n"
            } else {
                "[REDACTED PRIVATE KEY]"
            };
            result.push(placeholder);
            i = if found_end { j + 1 } else { lines.len() };
            continue;
        }
        result.push(lines[i]);
        i += 1;
    }
    result.concat()
}

#[cfg(test)]
mod tests {
    use super::super::SecuritySettings;
    use super::*;
    use serde_json::json;

    fn enabled_redact() -> SecuritySettings {
        SecuritySettings {
            enabled: true,
            redact_secrets: true,
            ..Default::default()
        }
    }

    fn disabled() -> SecuritySettings {
        SecuritySettings {
            enabled: false,
            redact_secrets: true,
            ..Default::default()
        }
    }

    fn no_redact_flag() -> SecuritySettings {
        SecuritySettings {
            enabled: true,
            redact_secrets: false,
            ..Default::default()
        }
    }

    #[test]
    fn mask_string_reuses_mask_evidence() {
        let s = "sk-abcdefghijklmnopqrstuvwxyz";
        assert_eq!(mask_string(s), mask_evidence(s));
        assert!(mask_string(s).contains("****"));
    }

    #[test]
    fn redact_string_sk_token() {
        let raw = "my key is sk-123456789012345678901234 and done";
        let out = redact_string(raw);
        assert!(out.contains("sk-****"));
        assert!(!out.contains("123456789012345678901234"));
    }

    #[test]
    fn redact_string_ghp_token() {
        let raw = "ghp_abcdefghijklmnopqrstuvwxyz12";
        assert_eq!(redact_string(raw), "ghp_****");
    }

    #[test]
    fn redact_string_akia_token() {
        let raw = "AKIAIOSFODNN7EXAMPLE";
        assert_eq!(redact_string(raw), "AKIA****");
    }

    #[test]
    fn redact_string_aiza_token() {
        let raw = "AIzaSyA-1234567890abcdef";
        assert_eq!(redact_string(raw), "AIza****");
    }

    #[test]
    fn redact_string_bearer_token() {
        let raw = "Authorization: Bearer abcdefghijklmnop";
        let out = redact_string(raw);
        assert_eq!(out, "Authorization: Bearer ab****");
    }

    #[test]
    fn redact_string_jwt() {
        let raw = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let out = redact_string(raw);
        assert!(out.starts_with("token=eyJ****"));
        assert!(!out.contains("eyJhbGci"));
    }

    #[test]
    fn redact_string_pem_private_key() {
        let raw = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n";
        let out = redact_string(raw);
        assert_eq!(out, "[REDACTED PRIVATE KEY]\n");
        assert!(!out.contains("b3BlbnNzaC1rZXk"));
    }

    #[test]
    fn redact_string_mixed_tokens() {
        let raw = "sk-123456789012345678901234 and Bearer abcdef and ghp_xxx123";
        let out = redact_string(raw);
        assert!(out.contains("sk-****"));
        assert!(out.contains("Bearer ab****"));
        assert!(out.contains("ghp_****"));
        assert!(!out.contains("123456789012345678901234"));
        assert!(!out.contains("abcdef"));
        assert!(!out.contains("xxx123"));
    }

    #[test]
    fn redact_string_gho_token_is_masked() {
        let raw = "gho_abcdefghijklmnopqrstuvwxyz12";
        assert_eq!(redact_string(raw), "gho_****");
    }

    #[test]
    fn redact_string_xoxb_token_is_masked() {
        let raw = "xoxb-1234567890123456789012345678";
        assert_eq!(redact_string(raw), "xoxb-****");
    }

    #[test]
    fn redact_string_sk_ant_token_is_masked_and_not_mangled() {
        let raw = "token sk-ant-api03-abc123 end";
        let out = redact_string(raw);
        assert!(out.contains("sk-ant-****"));
        assert!(!out.contains("api03"));
        assert!(!out.contains("abc123"));
    }

    #[test]
    fn redact_string_lowercase_akia_aiza_are_masked() {
        assert_eq!(redact_string("akiaiosfodnn7example"), "akia****");
        assert_eq!(redact_string("aizasya-1234567890abcdef"), "aiza****");
    }

    #[test]
    fn redact_json_for_logging_masks_all_detected_secret_prefixes() {
        let v = json!({
            "a": "gho_xxx123",
            "b": "xoxb-yyy456",
            "c": "sk-ant-api03-zzz789",
            "d": "akiaiosfodnn7example",
            "e": "aizasya-1234567890abcdef"
        });
        let out = redact_json_for_logging(&v);
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("xxx123"));
        assert!(!s.contains("yyy456"));
        assert!(!s.contains("zzz789"));
        assert!(!s.contains("iosfodnn7example"));
        assert!(!s.contains("1234567890abcdef"));
        assert!(s.contains("gho_****"));
        assert!(s.contains("xoxb-****"));
        assert!(s.contains("sk-ant-****"));
        assert!(s.contains("akia****"));
        assert!(s.contains("aiza****"));
    }

    #[test]
    fn is_secret_field_hits_named_secrets() {
        assert!(is_secret_field("Authorization"));
        assert!(is_secret_field("Cookie"));
        assert!(is_secret_field("sessionid"));
        assert!(is_secret_field("secret_key"));
        assert!(is_secret_field("access_key"));
        assert!(is_secret_field("database_url"));
        assert!(!is_secret_field("message"));
    }

    #[test]
    fn redact_json_secret_field_masks_whole_value() {
        let v = json!({"Authorization": "Bearer secret-token-xyz" });
        let out = redact_json(&v, &enabled_redact());
        let masked = out.get("Authorization").unwrap().as_str().unwrap();
        assert!(masked.contains("****"));
        assert!(!masked.contains("secret-token-xyz"));
    }

    #[test]
    fn redact_json_nested_and_secret_field() {
        let v = json!({
            "messages": [{"content": "my sk-123456789012345678901234 key"}],
            "headers": {"Authorization": "Bearer nestedtoken"}
        });
        let out = redact_json(&v, &enabled_redact());
        let content = out["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("sk-****"));
        let auth = out["headers"]["Authorization"].as_str().unwrap();
        assert!(auth.contains("****"));
        assert!(!auth.contains("nestedtoken"));
    }

    #[test]
    fn redact_json_only_when_enabled_and_flag() {
        let v = json!({"key": "sk-123456789012345678901234"});
        assert_ne!(redact_json(&v, &enabled_redact()), v);
        assert_eq!(redact_json(&v, &disabled()), v);
        assert_eq!(redact_json(&v, &no_redact_flag()), v);
    }

    #[test]
    fn redact_json_for_logging_unconditional() {
        let v = json!({"key": "sk-123456789012345678901234"});
        let out = redact_json_for_logging(&v);
        assert!(out["key"].as_str().unwrap().contains("sk-****"));
        // 与转发设置无关：即使禁用也打码
        let out2 = redact_json_for_logging(&v);
        assert_ne!(out2, v);
    }

    #[test]
    fn redact_json_for_logging_never_leaves_secret() {
        let v = json!({"Authorization": "Bearer topsecret"});
        let out = redact_json_for_logging(&v);
        let s = serde_json::to_string(&out).unwrap();
        assert!(!s.contains("topsecret"));
    }

    #[test]
    fn redact_string_bearer_token_with_equals_is_fully_masked() {
        let raw = "Authorization: Bearer abc=def";
        let out = redact_string(raw);
        assert_eq!(out, "Authorization: Bearer ab****");
        assert!(!out.contains("abc=def"));
        assert!(!out.contains("=def"));
    }

    #[test]
    fn redact_string_bearer_jwt_style_is_fully_masked() {
        let raw = "Authorization: Bearer aaa.bbb.ccc";
        let out = redact_string(raw);
        assert_eq!(out, "Authorization: Bearer aa****");
        assert!(!out.contains("aaa.bbb.ccc"));
        assert!(!out.contains(".bbb"));
    }

    #[test]
    fn redact_string_bearer_lowercase_is_masked() {
        let raw = "Authorization: bearer abcdef";
        let out = redact_string(raw);
        assert_eq!(out, "Authorization: bearer ab****");
        assert!(!out.contains("abcdef"));
    }

    #[test]
    fn redact_string_pem_truncated_is_fully_redacted() {
        let raw = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB\nYWJjZGVmZw==\n";
        let out = redact_string(raw);
        assert_eq!(out, "[REDACTED PRIVATE KEY]\n");
        assert!(!out.contains("b3BlbnNzaC1rZXk"));
        assert!(!out.contains("YWJjZGVmZw"));
    }

    #[test]
    fn redact_json_secret_field_non_string_is_masked_string() {
        let v = json!({"Authorization": {"token": "secret123"}});
        let out = redact_json(&v, &enabled_redact());
        let auth = &out["Authorization"];
        assert!(auth.is_string());
        let s = auth.as_str().unwrap();
        assert!(s.contains("****"));
        assert!(!s.contains("secret123"));
    }
}
