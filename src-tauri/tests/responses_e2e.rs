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

#[tokio::test]
async fn responses_non_stream_e2e() {
    let (base, _mock) = common::spawn_mock(
        200,
        serde_json::json!({
            "id": "c1",
            "object": "chat.completion",
            "model": "m",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "hello from responses" },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8 }
        }),
    )
    .await;

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

    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/responses", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model": "gpt-x",
            "input": "hi",
            "max_output_tokens": 64
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(v["object"], "response");
    let text = v["output"][0]["content"][0]["text"].as_str().unwrap();
    assert!(!text.is_empty());
    assert_eq!(v["usage"]["total_tokens"], 8);

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.protocol, "openai-chat");
    assert_eq!(log.status_code, Some(200));
}

#[tokio::test]
async fn responses_stream_sse_e2e() {
    let (base, _mock) = common::spawn_mock(
        200,
        serde_json::json!({
            "id": "c1",
            "object": "chat.completion",
            "model": "m",
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": "hello from stream" },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5 }
        }),
    )
    .await;

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

    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/responses", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model": "gpt-x",
            "input": "hi",
            "stream": true,
            "max_output_tokens": 64
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    let ct = resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ct.contains("text/event-stream"), "content-type was {ct}");
    let body = resp.text().await.unwrap();
    let created = body
        .find("response.created")
        .expect("missing response.created");
    let completed = body
        .find("response.completed")
        .expect("missing response.completed");
    assert!(
        created < completed,
        "response.created should appear before response.completed"
    );
    assert!(body.contains("\"delta\":\"hello from stream\""));

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.protocol, "openai-chat");
    assert_eq!(log.status_code, Some(200));
    assert_eq!(log.is_stream, false); // 内部非流式转发,响应侧合成 SSE
}
