mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
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

#[tokio::test]
async fn end_to_end_openai_with_role_route_and_logging() {
    let (base, _mock) = common::spawn_mock(200, serde_json::json!({
        "id":"c1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
    })).await;

    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", &base)).unwrap();
    repo.insert_api_key(&ApiKey {
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
    })
    .unwrap();
    // 角色路由：sonnet → c1/deepseek-v4-flash
    repo.upsert_role_route(&RoleRoute {
        id: "r1".into(),
        role: "sonnet".into(),
        channel_id: "c1".into(),
        target_model: "deepseek-v4-flash".into(),
        enabled: true,
        updated_at: 1,
    })
    .unwrap();

    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap(); // 0 = 随机端口

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4-20250514",
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert!(v["choices"].is_array());

    // 日志已入库，role/upstream_model 正确
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.role.as_deref(), Some("sonnet"));
    assert_eq!(
        log.request_model.as_deref(),
        Some("claude-sonnet-4-20250514")
    );
    assert_eq!(log.upstream_model.as_deref(), Some("deepseek-v4-flash"));
    assert_eq!(log.input_tokens, 10);
    // 配额已扣
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 15);
}

#[tokio::test]
async fn invalid_key_rejected_401() {
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    let (_h, addr) = server::start(state, 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer wrong")
        .json(&serde_json::json!({"model":"x","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn failure_paths_persist_request_log() {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_api_key(&ApiKey {
        id: "k1".into(),
        key: "sk-lgw-dead".into(),
        name: "dead".into(),
        enabled: true,
        quota_total: Some(100),
        quota_used: 100,
        total_calls: 0,
        total_tokens: 0,
        created_at: 1,
        last_used_at: None,
    })
    .unwrap();

    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let client = reqwest::Client::new();

    // invalid key → 401
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer wrong-key")
        .json(&serde_json::json!({"model":"x","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let v: serde_json::Value = resp.json().await.unwrap();
    let trace_401 = v["error"]["trace_id"].as_str().unwrap();
    assert!(!trace_401.is_empty());

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(401));
    assert_eq!(log.error.as_deref(), Some("invalid_api_key"));
    assert_eq!(log.protocol, "openai");
    assert!(!log.trace_id.is_empty());

    // quota exceeded → 429 (anthropic 端点，鉴权失败发生在协议解析之前)
    let resp = client
        .post(format!("http://{}/v1/messages", addr))
        .header("x-api-key", "sk-lgw-dead")
        .json(&serde_json::json!({"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}],"max_tokens":10}))
        .send().await.unwrap();
    assert_eq!(resp.status(), 429);
    let v: serde_json::Value = resp.json().await.unwrap();
    let trace_429 = v["error"]["trace_id"].as_str().unwrap();
    assert!(!trace_429.is_empty());

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(429));
    assert_eq!(log.error.as_deref(), Some("quota_exceeded"));
    assert_eq!(log.protocol, "anthropic");
    assert!(!log.trace_id.is_empty());
    assert_ne!(log.trace_id, trace_401);
}
