mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::protocol::openai;
use llm_gateway_lib::proxy::forwarder::{forward, ForwardError};
use llm_gateway_lib::proxy::server;
use llm_gateway_lib::proxy::state::AppState;

fn channel(id: &str, base: &str, ptype: &str, priority: i64) -> Channel {
    Channel {
        id: id.into(), name: id.into(), provider_type: ptype.into(),
        base_url: base.into(), api_key: "sk-test".into(), models: vec!["gpt-4o".into()],
        priority, weight: 1, enabled: true, timeout_secs: 5,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}

fn key(id: &str) -> ApiKey {
    ApiKey {
        id: id.into(), key: format!("sk-lgw-{}", id), name: id.into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }
}

fn ok_openai_body() -> serde_json::Value {
    serde_json::json!({
        "id":"chatcmpl-1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
    })
}

fn chat() -> llm_gateway_lib::protocol::types::ChatRequest {
    openai::request_to_chat(&serde_json::json!({
        "model":"gpt-4o","messages":[{"role":"user","content":"hi"}]
    })).unwrap()
}

fn setup_state(primary: Channel, secondary: Channel) -> (AppState, Repository) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&primary).unwrap();
    repo.insert_channel(&secondary).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    (state, repo)
}

fn api_key(repo: &Repository) -> ApiKey {
    repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap()
}

async fn assert_failover_to_secondary(
    primary_status: u16,
    primary_body: serde_json::Value,
) {
    let (primary_base, primary_mock) = common::spawn_mock(primary_status, primary_body).await;
    let (secondary_base, secondary_mock) = common::spawn_mock(200, ok_openai_body()).await;

    let primary = channel("primary", &primary_base, "openai", 10);
    let secondary = channel("secondary", &secondary_base, "openai", 5);
    let (state, repo) = setup_state(primary.clone(), secondary.clone());

    let res = forward(&state, &chat(), None, &api_key(&repo)).await.unwrap();
    assert_eq!(res.outcome.channel.id, "secondary");
    assert!(!secondary_mock.hits.lock().unwrap().is_empty(), "secondary should be hit");

    let primary_after = repo.get_channel("primary").unwrap().unwrap();
    assert!(primary_after.success_rate < 1.0, "primary success_rate should drop after failover");
    assert!(primary_mock.hits.lock().unwrap().len() == 1, "primary should be hit once");
}

#[tokio::test]
async fn dispatch_primary_401_falls_back() {
    assert_failover_to_secondary(401, serde_json::json!({"error":"unauthorized"})).await;
}

#[tokio::test]
async fn dispatch_primary_403_falls_back() {
    assert_failover_to_secondary(403, serde_json::json!({"error":"forbidden"})).await;
}

#[tokio::test]
async fn dispatch_primary_429_falls_back() {
    assert_failover_to_secondary(429, serde_json::json!({"error":"rate limited"})).await;
}

#[tokio::test]
async fn dispatch_primary_500_falls_back() {
    assert_failover_to_secondary(500, serde_json::json!({"error":"boom"})).await;
}

#[tokio::test]
async fn dispatch_primary_network_unreachable_falls_back() {
    let (secondary_base, secondary_mock) = common::spawn_mock(200, ok_openai_body()).await;

    let primary = channel("primary", "http://127.0.0.1:1", "openai", 10);
    let secondary = channel("secondary", &secondary_base, "openai", 5);
    let (state, repo) = setup_state(primary, secondary.clone());

    let res = forward(&state, &chat(), None, &api_key(&repo)).await.unwrap();
    assert_eq!(res.outcome.channel.id, "secondary");
    assert!(!secondary_mock.hits.lock().unwrap().is_empty(), "secondary should be hit");

    let primary_after = repo.get_channel("primary").unwrap().unwrap();
    assert!(primary_after.success_rate < 1.0, "primary success_rate should drop after network failure");
}

#[tokio::test]
async fn dispatch_all_candidates_fail_returns_5xx() {
    let (primary_base, _) = common::spawn_mock(500, serde_json::json!({"error":"primary boom"})).await;
    let (secondary_base, _) = common::spawn_mock(503, serde_json::json!({"error":"secondary down"})).await;

    let primary = channel("primary", &primary_base, "openai", 10);
    let secondary = channel("secondary", &secondary_base, "openai", 5);
    let (state, repo) = setup_state(primary, secondary);

    // 走完整 HTTP 处理链路，验证错误响应带 trace_id（forwarder::forward 本身不携带 trace_id）
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-k1")
        .json(&serde_json::json!({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send().await.unwrap();

    // 全部候选失败后返回最后一个候选的确定性状态码（secondary 的 503）
    assert_eq!(resp.status(), 503);
    let v: serde_json::Value = resp.json().await.unwrap();
    let trace_id = v["error"]["trace_id"].as_str().unwrap();
    assert!(!trace_id.is_empty(), "response must include a non-empty trace_id");

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(503));
    assert_eq!(log.trace_id, trace_id, "request log trace_id must match response trace_id");

    let primary_after = repo.get_channel("primary").unwrap().unwrap();
    let secondary_after = repo.get_channel("secondary").unwrap().unwrap();
    assert!(primary_after.success_rate < 1.0, "primary success_rate should drop");
    assert!(secondary_after.success_rate < 1.0, "secondary success_rate should drop");
}

#[tokio::test]
async fn dispatch_primary_400_does_not_fallback() {
    let (primary_base, primary_mock) = common::spawn_mock(400, serde_json::json!({"error":"bad request"})).await;
    let (secondary_base, secondary_mock) = common::spawn_mock(200, ok_openai_body()).await;

    let primary = channel("primary", &primary_base, "openai", 10);
    let secondary = channel("secondary", &secondary_base, "openai", 5);
    let (state, repo) = setup_state(primary, secondary);

    let err = forward(&state, &chat(), None, &api_key(&repo)).await.unwrap_err();
    match err {
        ForwardError::Upstream { status, .. } => assert_eq!(status, 400),
        other => panic!("expected Upstream 400, got {:?}", other),
    }

    assert_eq!(primary_mock.hits.lock().unwrap().len(), 1);
    assert!(secondary_mock.hits.lock().unwrap().is_empty(), "secondary should NOT be hit for non-failover 4xx");

    let primary_after = repo.get_channel("primary").unwrap().unwrap();
    assert!(primary_after.success_rate < 1.0, "primary success_rate should drop after 400");
}
