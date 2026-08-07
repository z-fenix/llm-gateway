mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, RequestSecurityFinding};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        provider_type: "openai".into(),
        base_url: base.into(),
        api_key: "sk-real".into(),
        models: vec![],
        priority: 0,
        weight: 1,
        enabled: true,
        timeout_secs: 5,
        total_calls: 0,
        total_tokens: 0,
        success_rate: 1.0,
        avg_latency_ms: 0,
        created_at: 1,
        updated_at: 1,
    }
}

fn api_key() -> ApiKey {
    ApiKey {
        id: "k1".into(),
        key: "sk-lgw-test".into(),
        name: "t".into(),
        enabled: true,
        quota_total: None,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: 1,
        last_used_at: None,
    }
}

fn clean_body() -> serde_json::Value {
    serde_json::json!({
        "model": "gpt-4o",
        "stream": true,
        "messages": [{"role": "user", "content": "hello"}]
    })
}

async fn setup_state() -> (AppState, Repository) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_api_key(&api_key()).unwrap();
    let state = AppState::new(db);
    (state, repo)
}

async fn wait_for_stream_log(repo: &Repository) -> llm_gateway_lib::db::models::RequestLog {
    for _ in 0..50 {
        if let Ok(Some(log)) = repo.latest_log() {
            if log.is_stream {
                return log;
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    }
    panic!("stream request log was not written");
}

async fn wait_for_response_findings(
    repo: &Repository,
    log_id: &str,
) -> Vec<RequestSecurityFinding> {
    for _ in 0..50 {
        if let Ok(findings) = repo.get_findings(log_id) {
            if findings.iter().any(|f| f.phase == "response") {
                return findings;
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
    }
    panic!("response-phase findings were not persisted");
}

#[tokio::test]
async fn stream_audit_chunks_untouched_and_response_findings_logged() {
    let chunks = vec![
        r#"data: {"choices":[{"index":0,"delta":{"content":"my key is sk-123456789012345"}}]}"#.to_string() + "\n\n",
        r#"data: {"choices":[{"index":0,"delta":{"content":"678901234"}}]}"#.to_string() + "\n\n",
        "data: [DONE]\n\n".to_string(),
    ];
    let expected_body = chunks.join("");
    let (base, mock) = common::spawn_mock_stream(chunks).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "audit".into();
        sec.scan_response = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "text/event-stream"
    );

    let body_bytes = resp.bytes().await.unwrap();
    assert_eq!(
        body_bytes.as_ref(),
        expected_body.as_bytes(),
        "forwarded SSE body must be byte-for-byte identical to upstream"
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = wait_for_stream_log(&repo).await;
    assert_eq!(log.status_code, Some(200));
    assert!(log.is_stream);

    assert_ne!(log.risk_level, "clean", "response risk should be reflected in log");
    assert!(log.risk_score > 0);
    assert!(
        log.risk_summary.as_ref().unwrap().contains("API"),
        "risk_summary should mention the finding: {:?}",
        log.risk_summary
    );

    let findings = wait_for_response_findings(&repo, &log.id).await;
    assert!(
        findings.iter().any(|f| f.phase == "response"),
        "expected a response-phase finding"
    );
    assert!(
        findings.iter().any(|f| f.rule_id == "credential.secret_token"),
        "expected credential.secret_token finding: {:?}",
        findings
    );
}

#[tokio::test]
async fn stream_audit_persists_request_phase_findings() {
    let chunks = vec![
        r#"data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}"#.to_string() + "\n\n",
        "data: [DONE]\n\n".to_string(),
    ];
    let secret_body = serde_json::json!({
        "model": "gpt-4o",
        "stream": true,
        "messages": [{"role": "user", "content": "my key is sk-123456789012345678901234"}]
    });
    let (base, mock) = common::spawn_mock_stream(chunks).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "audit".into();
        sec.scan_request = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body)
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let _ = resp.bytes().await;
    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = wait_for_stream_log(&repo).await;
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().any(|f| f.phase == "request"),
        "expected a request-phase finding: {:?}",
        findings
    );
    assert!(
        findings.iter().any(|f| f.rule_id == "credential.secret_token"),
        "expected credential.secret_token finding: {:?}",
        findings
    );
}

#[tokio::test]
async fn stream_response_redact_does_not_set_sanitized_flag() {
    let chunks = vec![
        r#"data: {"choices":[{"index":0,"delta":{"content":"my key is sk-123456789012345"}}]}"#.to_string() + "\n\n",
        r#"data: {"choices":[{"index":0,"delta":{"content":"678901234"}}]}"#.to_string() + "\n\n",
        "data: [DONE]\n\n".to_string(),
    ];
    let (base, mock) = common::spawn_mock_stream(chunks).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "redact".into();
        sec.scan_response = true;
        sec.redact_secrets = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let _ = resp.bytes().await;
    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = wait_for_stream_log(&repo).await;
    assert!(
        !log.sanitized,
        "stream response redact should not set sanitized flag"
    );
}

#[tokio::test]
async fn stream_scan_disabled_leaves_clean_log() {
    let chunks = vec![
        r#"data: {"choices":[{"index":0,"delta":{"content":"my key is sk-123456789012345"}}]}"#.to_string() + "\n\n",
        r#"data: {"choices":[{"index":0,"delta":{"content":"678901234"}}]}"#.to_string() + "\n\n",
        "data: [DONE]\n\n".to_string(),
    ];
    let expected_body = chunks.join("");
    let (base, mock) = common::spawn_mock_stream(chunks).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "audit".into();
        sec.scan_response = false;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let body_bytes = resp.bytes().await.unwrap();
    assert_eq!(
        body_bytes.as_ref(),
        expected_body.as_bytes(),
        "forwarded SSE body must be byte-for-byte identical to upstream"
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = wait_for_stream_log(&repo).await;
    assert_eq!(log.risk_level, "clean");
    assert_eq!(log.risk_score, 0);
    assert_eq!(log.security_action, "allow");

    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().all(|f| f.phase != "response"),
        "no response findings should be persisted when scan_response=false"
    );
}
