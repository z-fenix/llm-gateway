mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::protocol::openai;
use llm_gateway_lib::proxy::forwarder::{forward, ForwardError};
use llm_gateway_lib::proxy::state::AppState;

fn channel(id: &str, base: &str, ptype: &str) -> Channel {
    Channel {
        id: id.into(), name: id.into(), provider_type: ptype.into(),
        base_url: base.into(), api_key: "sk-real".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 5,
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
    }))
    .unwrap()
}

#[tokio::test]
async fn role_route_hits_bound_channel() {
    let (base, mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", &base, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some(("c1".into(), "deepseek-v4-flash".into())), &ak).await.unwrap();
    assert_eq!(res.outcome.channel.id, "c1");
    assert!(!res.outcome.via_fallback);
    // 上游收到的 model 是映射后的
    let hit = mock.hits.lock().unwrap()[0].clone();
    assert_eq!(hit["model"], "deepseek-v4-flash");
}

#[tokio::test]
async fn role_channel_5xx_falls_back() {
    let (bad, _) = common::spawn_mock(500, serde_json::json!({"error":"boom"})).await;
    let (good, good_mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("role-ch", &bad, "openai")).unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    *state.fallback.write() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some(("role-ch".into(), "m1".into())), &ak).await.unwrap();
    assert_eq!(res.outcome.channel.id, "fb-ch");
    assert!(res.outcome.via_fallback);
    assert!(!good_mock.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn role_4xx_does_not_fallback() {
    let (bad, _) = common::spawn_mock(400, serde_json::json!({"error":"bad request"})).await;
    let (good, _) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("role-ch", &bad, "openai")).unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    *state.fallback.write() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let err = forward(&state, &chat(), Some(("role-ch".into(), "m1".into())), &ak).await.unwrap_err();
    match err {
        ForwardError::Upstream { status, .. } => assert_eq!(status, 400),
        other => panic!("expected Upstream 400, got {:?}", other),
    }
}
