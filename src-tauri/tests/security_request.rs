mod common;

use axum::{routing::post, Router};
use futures::stream;
use llm_gateway_lib::db::models::{ApiKey, Channel};
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

fn secret_body() -> serde_json::Value {
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "my key is sk-123456789012345678901234"}]
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
async fn request_block_returns_451_and_no_upstream_hit() {
    let (base, mock) = common::spawn_mock(200, serde_json::json!({
        "id": "c1", "object": "chat.completion", "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "block".into();
        sec.scan_request = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 451);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["error"]["code"], "blocked_by_security");
    assert!(!v["error"]["trace_id"].as_str().unwrap().is_empty());

    // 命中内容绝不到上游
    assert!(mock.hits.lock().unwrap().is_empty());

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(451));
    assert_eq!(log.security_action, "block");
    assert!(log.blocked_reason.is_some());
    assert!(
        log.risk_level == "high" || log.risk_level == "critical",
        "risk_level should be high or critical, got {}",
        log.risk_level
    );
    assert!(log.risk_score > 0);

    let findings = repo.get_findings(&log.id).unwrap();
    assert!(!findings.is_empty());
    assert!(findings.iter().any(|f| f.phase == "request"));
}

#[tokio::test]
async fn request_redact_masks_secret_before_upstream() {
    let (base, mock) = common::spawn_mock(200, serde_json::json!({
        "id": "c1", "object": "chat.completion", "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })).await;

    let (state, repo) = setup_state().await;
    repo.insert_channel(&channel("c1", &base)).unwrap();

    {
        let mut sec = state.security.write().unwrap();
        sec.enabled = true;
        sec.mode = "redact".into();
        sec.scan_request = true;
        sec.redact_secrets = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);

    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let upstream_body = &hits[0];
    let content = upstream_body["messages"][0]["content"].as_str().unwrap();
    assert!(
        !content.contains("sk-123456789012345678901234"),
        "upstream should not receive raw secret: {}",
        content
    );
    assert!(content.contains("sk-****"), "upstream body should contain masked token: {}", content);

    let log = repo.latest_log().unwrap().unwrap();
    assert!(log.sanitized);
    assert_eq!(log.security_action, "redact");
    let persisted = log.request_body.unwrap();
    assert!(
        !persisted.contains("sk-123456789012345678901234"),
        "persisted request body should be masked: {}",
        persisted
    );
}

#[tokio::test]
async fn request_audit_records_risk_but_forwards_original() {
    let (base, mock) = common::spawn_mock(200, serde_json::json!({
        "id": "c1", "object": "chat.completion", "model": "m",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })).await;

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
        .json(&secret_body())
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);

    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let upstream_body = &hits[0];
    let content = upstream_body["messages"][0]["content"].as_str().unwrap();
    assert!(
        content.contains("sk-123456789012345678901234"),
        "upstream should receive original secret in audit mode: {}",
        content
    );

    let log = repo.latest_log().unwrap().unwrap();
    assert_ne!(log.risk_level, "clean");
    assert_eq!(log.security_action, "allow");
    assert!(log.risk_score > 0);
    let persisted = log.request_body.unwrap();
    assert!(
        !persisted.contains("sk-123456789012345678901234"),
        "persisted request body must still be masked: {}",
        persisted
    );
}

async fn spawn_sse_upstream() -> String {
    let app = Router::new().route("/v1/chat/completions", post(|| async {
        let chunks = vec![
            Ok::<_, std::convert::Infallible>(r#"data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}"#.to_string() + "\n\n"),
            Ok("data: [DONE]".to_string() + "\n\n"),
        ];
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

#[tokio::test]
async fn stream_audit_masks_persisted_body_even_when_forwarding_original() {
    let base = spawn_sse_upstream().await;

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
    let mut body = secret_body();
    body["stream"] = serde_json::json!(true);
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&body)
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let log = repo.latest_log().unwrap().unwrap();
    assert!(log.is_stream);
    // risk columns are not yet threaded into stream logs (Task 9); here we only
    // verify the trust boundary: persisted request body is masked.
    let persisted = log.request_body.unwrap();
    assert!(
        !persisted.contains("sk-123456789012345678901234"),
        "stream persisted request body must be masked: {}",
        persisted
    );
}

