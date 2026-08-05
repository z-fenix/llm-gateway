mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(), name: id.into(), provider_type: "openai".into(),
        base_url: base.into(), api_key: "sk-real".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 5,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
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
        id: "k1".into(), key: "sk-lgw-test".into(), name: "t".into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }).unwrap();
    // 角色路由：sonnet → c1/deepseek-v4-flash
    repo.upsert_role_route(&RoleRoute {
        id: "r1".into(), role: "sonnet".into(), channel_id: "c1".into(),
        target_model: "deepseek-v4-flash".into(), enabled: true, updated_at: 1,
    }).unwrap();

    let state = AppState::new(db);
    let _h = server::start(state.clone(), 0).await; // 0 = 随机端口，需 server 返回实际地址
    let addr = server::bound_addr().unwrap();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4-20250514",
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert!(v["choices"].is_array());

    // 日志已入库，role/upstream_model 正确
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.role.as_deref(), Some("sonnet"));
    assert_eq!(log.request_model.as_deref(), Some("claude-sonnet-4-20250514"));
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
    let _h = server::start(state, 0).await;
    let addr = server::bound_addr().unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer wrong")
        .json(&serde_json::json!({"model":"x","messages":[]}))
        .send().await.unwrap();
    assert_eq!(resp.status(), 401);
}
