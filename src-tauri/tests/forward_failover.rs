mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::protocol::openai;
use llm_gateway_lib::proxy::forwarder::{forward, ForwardError};
use llm_gateway_lib::proxy::state::AppState;

fn channel(id: &str, base: &str, ptype: &str) -> Channel {
    let upstream_protocol = match ptype {
        "claude" | "anthropic" => "anthropic-messages",
        "gemini" => "gemini-native",
        _ => "openai-chat",
    };
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: ptype.into(),
        upstream_protocol: upstream_protocol.into(),
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

fn key(id: &str) -> ApiKey {
    ApiKey {
        id: id.into(),
        key: format!("sk-lgw-{}", id),
        name: id.into(),
        enabled: true,
        quota_total: None,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: 1,
        last_used_at: None,
    }
}

fn ok_openai_body() -> serde_json::Value {
    serde_json::json!({
        "id":"chatcmpl-1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
    })
}

fn role_route(
    id: &str,
    role: &str,
    channel_id: &str,
    model: &str,
    priority: i64,
    weight: i64,
    max_failures: i64,
) -> RoleRoute {
    RoleRoute {
        id: id.into(),
        role: role.into(),
        channel_id: channel_id.into(),
        target_model: model.into(),
        priority,
        weight,
        breaker_max_failures: max_failures,
        breaker_cooldown_secs: 60,
        enabled: true,
        updated_at: 1,
    }
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
    repo.insert_channel(&channel("c1", &base, "openai"))
        .unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    repo.upsert_role_route(&role_route("rr1", "sonnet", "c1", "deepseek-v4-flash", 0, 1, 5))
        .unwrap();
    let state = AppState::new(db);
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap();
    assert_eq!(res.outcome.channel.id, "c1");
    assert!(!res.outcome.via_fallback);
    // 上游收到的 model 是路由配置的目标模型
    let hit = mock.hits.lock().unwrap()[0].clone();
    assert_eq!(hit["model"], "deepseek-v4-flash");
}

#[tokio::test]
async fn role_channel_5xx_falls_back() {
    let (bad, _) = common::spawn_mock(500, serde_json::json!({"error":"boom"})).await;
    let (good, good_mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("role-ch", &bad, "openai"))
        .unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai"))
        .unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    repo.upsert_role_route(&role_route("rr1", "sonnet", "role-ch", "m1", 0, 1, 5))
        .unwrap();
    let state = AppState::new(db);
    *state.fallback.write() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap();
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
    repo.insert_channel(&channel("role-ch", &bad, "openai"))
        .unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai"))
        .unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    repo.upsert_role_route(&role_route("rr1", "sonnet", "role-ch", "m1", 0, 1, 5))
        .unwrap();
    let state = AppState::new(db);
    *state.fallback.write() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let err = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap_err();
    match err {
        ForwardError::Upstream { status, .. } => assert_eq!(status, 400),
        other => panic!("expected Upstream 400, got {:?}", other),
    }
}

#[tokio::test]
async fn role_multi_provider_fails_over_within_role() {
    let (bad, _) = common::spawn_mock(500, serde_json::json!({"error":"boom"})).await;
    let (good, good_mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("bad-ch", &bad, "openai"))
        .unwrap();
    repo.insert_channel(&channel("good-ch", &good, "openai"))
        .unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    // 同一角色两条路由：高优先级 bad-ch 失败后切到 good-ch
    repo.upsert_role_route(&role_route("ra", "sonnet", "bad-ch", "m-a", 10, 1, 5))
        .unwrap();
    repo.upsert_role_route(&role_route("rb", "sonnet", "good-ch", "m-b", 0, 1, 5))
        .unwrap();
    let state = AppState::new(db);
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap();
    assert_eq!(res.outcome.channel.id, "good-ch");
    assert!(!res.outcome.via_fallback);
    let hit = good_mock.hits.lock().unwrap()[0].clone();
    assert_eq!(hit["model"], "m-b");
}

#[tokio::test]
async fn role_breaker_trips_and_skips_route() {
    let (bad, _) = common::spawn_mock(500, serde_json::json!({"error":"boom"})).await;
    let (good, good_mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("bad-ch", &bad, "openai"))
        .unwrap();
    repo.insert_channel(&channel("good-ch", &good, "openai"))
        .unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    // ra 熔断阈值 1：第一次失败即 open，之后请求直接跳过 ra 走 rb
    repo.upsert_role_route(&role_route("ra", "sonnet", "bad-ch", "m-a", 10, 1, 1))
        .unwrap();
    repo.upsert_role_route(&role_route("rb", "sonnet", "good-ch", "m-b", 0, 1, 5))
        .unwrap();
    let state = AppState::new(db);
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();

    // 第 1 次：ra 失败(→open) 后切 rb 成功
    let r1 = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap();
    assert_eq!(r1.outcome.channel.id, "good-ch");
    assert_eq!(state.circuit_breakers.read().get("ra").unwrap().state(), llm_gateway_lib::router::breaker::BreakerState::Open);

    // 第 2 次：ra 已 open 被跳过，直接命中 rb
    let r2 = forward(&state, &chat(), Some("sonnet".into()), &ak)
        .await
        .unwrap();
    assert_eq!(r2.outcome.channel.id, "good-ch");
    assert_eq!(good_mock.hits.lock().unwrap().len(), 2);
}
