use crate::db::models::{ApiKey, RequestLog, RequestSecurityFinding};
use crate::db::repository::Repository;
use crate::proxy::state::AppState;
use crate::security::{
    decide_action, redact::redact_json_for_logging, redact_request_body, rules,
    SecurityAction, SecurityFinding, SecurityScanResult, SecuritySettings,
};
use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;

pub enum RequestVerdict {
    /// 继续转发；携带（可能被脱敏的）统一格式 body + 扫描结果供日志使用
    Proceed { body: serde_json::Value, scan: SecurityScanResult },
    /// 阻断；已写好 request_log + findings，直接返回该 451 响应
    Blocked(axum::response::Response),
}

/// 执行一次扫描（请求或响应侧），合并自定义黑白名单、白名单抑制后重新评分决策。
fn run_scan_with_custom(
    body: &serde_json::Value,
    phase: &str,
    settings: &SecuritySettings,
    repo: &Repository,
) -> SecurityScanResult {
    let mut scan = match phase {
        "request" => crate::security::scan_request(body, settings),
        "response" => crate::security::scan_response(body, settings),
        _ => crate::security::scan_request(body, settings),
    };

    let custom = match repo.list_custom_rules() {
        Ok(rules) => rules,
        Err(e) => {
            log::error!("failed to list custom security rules: {}", e);
            Vec::new()
        }
    };

    // 合并自定义黑名单规则：按 JSON 字符串叶子逐条匹配，并带上 JSON-path 位置
    walk_and_apply_custom(body, "$", phase, settings, &custom, &mut scan.findings);

    // 白名单抑制：在值层面判断该 finding 是否应被放行
    let mut filtered = Vec::with_capacity(scan.findings.len());
    for f in scan.findings {
        let value_str = value_at_path(body, &f.location)
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        if rules::is_whitelisted(&f.category, &value_str, &custom) {
            continue;
        }
        filtered.push(f);
    }

    // 自定义规则或白名单可能改变风险等级，重新评分并决策
    scan = crate::security::scanner::compute_result(filtered);
    decide_action(&mut scan, settings);
    scan
}

pub async fn inspect_request(
    state: &AppState,
    trace_id: &str,
    api_key: &ApiKey,
    proto_str: &str,
    request_model: &str,
    chat_body: &serde_json::Value,
) -> RequestVerdict {
    let settings = state.security.read().clone();
    if !settings.enabled || !settings.scan_request {
        return RequestVerdict::Proceed {
            body: chat_body.clone(),
            scan: SecurityScanResult::default(),
        };
    }

    let mut scan = run_scan_with_custom(chat_body, "request", &settings, &state.repo);

    match scan.action {
        SecurityAction::Block => {
            let log = RequestLog {
                id: uuid::Uuid::new_v4().to_string(),
                seq: 0,
                trace_id: trace_id.to_string(),
                api_key_id: Some(api_key.id.clone()),
                key_name: Some(api_key.name.clone()),
                channel_id: None,
                channel_name: None,
                role: None,
                request_model: Some(request_model.to_string()),
                upstream_model: None,
                protocol: proto_str.to_string(),
                status_code: Some(451),
                input_tokens: 0,
                output_tokens: 0,
                latency_ms: 0,
                is_stream: false,
                error: Some("blocked_by_security".to_string()),
                fallback: false,
                tool_calls: None,
                request_body: Some(redact_json_for_logging(chat_body).to_string()),
                response_body: None,
                risk_level: risk_level_to_string(&scan.risk_level),
                risk_score: scan.risk_score,
                risk_summary: Some(scan.summary.clone()),
                security_action: scan.action.as_str().to_string(),
                sanitized: false,
                blocked_reason: scan.blocked_reason.clone(),
                created_at: chrono::Utc::now().timestamp(),
            };
            if let Err(e) = state.repo.insert_log(&log) {
                log::error!("failed to insert block request log: {}", e);
            }
            for f in &scan.findings {
                if let Err(e) = insert_finding(&state.repo, &log.id, "request", f) {
                    log::error!("failed to insert security finding: {}", e);
                }
            }
            let resp = (
                StatusCode::from_u16(451).unwrap(),
                Json(json!({
                    "error": {
                        "code": "blocked_by_security",
                        "trace_id": trace_id,
                        "summary": scan.summary
                    }
                })),
            )
                .into_response();
            RequestVerdict::Blocked(resp)
        }
        SecurityAction::Redact => {
            let (new_body, changed) = redact_request_body(chat_body, &settings);
            scan.sanitized = changed;
            RequestVerdict::Proceed { body: new_body, scan }
        }
        _ => RequestVerdict::Proceed {
            body: chat_body.clone(),
            scan,
        },
    }
}

/// 非流式响应侧检测：扫描上游响应体并按四模式决策。
pub fn inspect_response(state: &AppState, resp_body: &serde_json::Value) -> SecurityScanResult {
    let settings = state.security.read().clone();
    if !settings.enabled || !settings.scan_response {
        return SecurityScanResult::default();
    }
    run_scan_with_custom(resp_body, "response", &settings, &state.repo)
}

fn walk_and_apply_custom(
    value: &serde_json::Value,
    path: &str,
    phase: &str,
    settings: &SecuritySettings,
    custom_rules: &[crate::db::models::CustomRule],
    findings: &mut Vec<SecurityFinding>,
) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let child = if path == "$" {
                    format!("$.{}", k)
                } else {
                    format!("{}.{}", path, k)
                };
                walk_and_apply_custom(v, &child, phase, settings, custom_rules, findings);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                let child = format!("{}[{}]", path, i);
                walk_and_apply_custom(v, &child, phase, settings, custom_rules, findings);
            }
        }
        serde_json::Value::String(text) => {
            let text = crate::security::scanner::truncate_to_bytes(text, settings.max_scan_bytes);
            rules::apply_custom_rules(text, phase, path, custom_rules, findings);
        }
        _ => {}
    }
}

fn value_at_path<'a>(
    root: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    if path == "$" {
        return Some(root);
    }
    let rest = path.strip_prefix('$')?;
    if rest.is_empty() {
        return Some(root);
    }
    let mut current = root;
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => {
                i += 1;
                let start = i;
                while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                    i += 1;
                }
                let key: String = chars[start..i].iter().collect();
                current = current.get(&key)?;
            }
            '[' => {
                i += 1;
                let start = i;
                while i < chars.len() && chars[i] != ']' {
                    i += 1;
                }
                let idx: usize = chars[start..i].iter().collect::<String>().parse().ok()?;
                i += 1; // skip ']'
                current = current.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

fn risk_level_to_string(level: &crate::security::RiskLevel) -> String {
    serde_json::to_string(level)
        .unwrap()
        .trim_matches('"')
        .to_string()
}

pub(crate) fn insert_finding(
    repo: &Repository,
    log_id: &str,
    phase: &str,
    finding: &SecurityFinding,
) -> crate::error::AppResult<()> {
    repo.insert_finding(&RequestSecurityFinding {
        id: uuid::Uuid::new_v4().to_string(),
        log_id: log_id.to_string(),
        phase: phase.to_string(),
        category: finding.category.clone(),
        rule_id: finding.rule_id.clone(),
        severity: risk_level_to_string(&finding.severity),
        title: finding.title.clone(),
        description: finding.description.clone(),
        location: Some(finding.location.clone()),
        evidence_masked: finding.evidence_masked.clone(),
        evidence_hash: None,
        action: None,
        created_at: chrono::Utc::now().timestamp(),
    })
}
