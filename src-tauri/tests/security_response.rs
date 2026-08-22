mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
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
        "messages": [{"role": "user", "content": "hello"}]
    })
}

fn secret_response() -> serde_json::Value {
    serde_json::json!({
        "id": "c1",
        "object": "chat.completion",
        "model": "m",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "my key is sk-123456789012345678901234"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })
}

async fn setup_state() -> (AppState, Repository) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_api_key(&api_key()).unwrap();
    let state = AppState::new(db);
    (state, repo)
}

#[tokio::test]
async fn response_block_returns_451_and_no_secret_to_client() {
    let (base, mock) = common::spawn_mock(200, secret_response()).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write();
        sec.enabled = true;
        sec.mode = "block".into();
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

    assert_eq!(resp.status(), 451);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["error"]["code"], "blocked_by_security");
    assert!(!v["error"]["trace_id"].as_str().unwrap().is_empty());
    let summary = v["error"]["summary"].as_str().unwrap();
    assert!(
        summary.starts_with("响应侧："),
        "summary should fold phase: {}",
        summary
    );
    assert!(summary.contains("风险"));

    // 上游响应中的敏感内容不能到达调用方
    let body_text = serde_json::to_string(&v).unwrap();
    assert!(!body_text.contains("sk-123456789012345678901234"));

    // 上游确实被命中（请求已转发）
    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(451));
    assert_eq!(log.security_action, "block");
    assert!(log.blocked_reason.is_some(), "blocked_reason should be set");

    let response_body = log
        .response_body
        .as_ref()
        .expect("response_body should be logged");
    assert!(
        response_body.contains("sk-****"),
        "response_body in log should be masked: {}",
        response_body
    );
    assert!(
        !response_body.contains("sk-123456789012345678901234"),
        "response_body must not contain raw secret: {}",
        response_body
    );

    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        !findings.is_empty(),
        "response findings should be persisted"
    );
    assert!(
        findings.iter().any(|f| f.phase == "response"),
        "expected a response-phase finding"
    );
    assert!(findings
        .iter()
        .any(|f| f.rule_id == "credential.secret_token"));
}

#[tokio::test]
async fn response_audit_records_findings_but_passes_through() {
    let (base, mock) = common::spawn_mock(200, secret_response()).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write();
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
    let v: serde_json::Value = resp.json().await.unwrap();
    let content = v["choices"][0]["message"]["content"].as_str().unwrap();
    assert!(
        content.contains("sk-123456789012345678901234"),
        "audit mode should return original upstream content: {}",
        content
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(200));
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(!findings.is_empty());
    assert!(findings.iter().any(|f| f.phase == "response"));
}

#[tokio::test]
async fn response_redact_masks_secret_before_client() {
    let (base, mock) = common::spawn_mock(200, secret_response()).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write();
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
    let v: serde_json::Value = resp.json().await.unwrap();
    let content = v["choices"][0]["message"]["content"].as_str().unwrap();
    assert!(
        !content.contains("sk-123456789012345678901234"),
        "client-facing content should be masked: {}",
        content
    );
    assert!(
        content.contains("sk-****"),
        "client-facing content should contain masked token: {}",
        content
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = repo.latest_log().unwrap().unwrap();
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(findings.iter().any(|f| f.phase == "response"));
}

#[tokio::test]
async fn response_scan_disabled_passes_through_and_leaves_no_findings() {
    let (base, mock) = common::spawn_mock(200, secret_response()).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write();
        sec.enabled = true;
        sec.mode = "block".into();
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
    let v: serde_json::Value = resp.json().await.unwrap();
    let content = v["choices"][0]["message"]["content"].as_str().unwrap();
    assert!(
        content.contains("sk-123456789012345678901234"),
        "scan_response=false must passthrough original content: {}",
        content
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = repo.latest_log().unwrap().unwrap();
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().all(|f| f.phase != "response"),
        "no response findings should be persisted when scan_response=false"
    );
}

#[tokio::test]
async fn security_disabled_passes_through_and_leaves_no_findings() {
    let (base, mock) = common::spawn_mock(200, secret_response()).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write();
        sec.enabled = false;
        sec.mode = "block".into();
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
    let v: serde_json::Value = resp.json().await.unwrap();
    let content = v["choices"][0]["message"]["content"].as_str().unwrap();
    assert!(
        content.contains("sk-123456789012345678901234"),
        "security disabled must passthrough original content: {}",
        content
    );

    assert_eq!(mock.hits.lock().unwrap().len(), 1);

    let log = repo.latest_log().unwrap().unwrap();
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().all(|f| f.phase != "response"),
        "no response findings should be persisted when security disabled"
    );
}
