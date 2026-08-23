mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "anthropic".into(),
        upstream_protocol: "anthropic-messages".into(),
        base_url: base.into(),
        api_key: "sk-test".into(),
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

fn ok_anthropic_body() -> serde_json::Value {
    serde_json::json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-20250514",
        "content": [{"type": "text", "text": "hi"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 5}
    })
}

async fn setup(base: &str, key_id: &str) -> (AppState, String) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", base)).unwrap();
    repo.insert_api_key(&key(key_id)).unwrap();
    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap(); // 0 = 随机端口
    (state, addr.to_string())
}

/// 发送含 thinking block 的 Anthropic /v1/messages 请求。
/// signature 错误触发整流重试：第二次请求体应不再含 type=="thinking" block。
#[tokio::test]
async fn signature_error_triggers_rectify_and_retry() {
    let (mock_base, mock) = common::spawn_rectifier_mock(
        400,
        serde_json::json!({
            "error": {"message": "Invalid 'signature' in 'thinking' block"}
        }),
        200,
        ok_anthropic_body(),
    )
    .await;
    let (state, addr) = setup(&mock_base, "k1").await;

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/messages", addr))
        .header("x-api-key", "sk-lgw-k1")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                {"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "let me think", "signature": "sig-1"},
                    {"type": "text", "text": "answer"}
                ]}
            ]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);

    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 2, "should rectify and retry exactly once");
    // 第一次请求体含 thinking block
    let first_has_thinking = hits[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| {
            m["content"]
                .as_array()
                .map(|c| {
                    c.iter()
                        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                })
                .unwrap_or(false)
        });
    assert!(first_has_thinking, "first request should contain a thinking block");
    // 第二次(整流后)请求体不再含 thinking block
    let second_has_thinking = hits[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| {
            m["content"]
                .as_array()
                .map(|c| {
                    c.iter()
                        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                })
                .unwrap_or(false)
        });
    assert!(!second_has_thinking, "rectified request should drop thinking blocks");
    drop(hits);

    let log = state.repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(200));
}

/// 与 signature/budget 无关的错误：不整流、不重试，返回原始 400。
#[tokio::test]
async fn unrectifiable_error_returns_original() {
    let (mock_base, mock) = common::spawn_rectifier_mock(
        400,
        serde_json::json!({"error": {"message": "insufficient_quota: over limit"}}),
        200,
        ok_anthropic_body(),
    )
    .await;
    let (state, addr) = setup(&mock_base, "k2").await;

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/messages", addr))
        .header("x-api-key", "sk-lgw-k2")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 400);
    assert_eq!(
        mock.hits.lock().unwrap().len(),
        1,
        "unrectifiable error should NOT retry"
    );

    let log = state.repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(400));
}

/// 纯文本模型(heuristic)的 image block 在发送前被降级为 [Unsupported Image]。
#[tokio::test]
async fn media_fallback_strips_images() {
    let (mock_base, mock) = common::spawn_rectifier_mock(200, ok_anthropic_body(), 200, ok_anthropic_body())
        .await;
    let (state, addr) = setup(&mock_base, "k3").await;

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/messages", addr))
        .header("x-api-key", "sk-lgw-k3")
        .json(&serde_json::json!({
            "model": "claude-3-haiku-20240307",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image", "source": {"type": "base64", "data": "aGVsbG8="}}
                ]}
            ]
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);

    let hits = mock.hits.lock().unwrap();
    assert_eq!(hits.len(), 1, "200 response should not trigger retry");
    let sent = &hits[0];
    // image block 已被替换为文本占位符
    for msg in sent["messages"].as_array().unwrap() {
        for block in msg["content"].as_array().unwrap() {
            assert_ne!(
                block.get("type").and_then(|t| t.as_str()),
                Some("image"),
                "image block should be stripped for text-only model"
            );
        }
    }
    let blocks = &sent["messages"][0]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], "text");
    assert_eq!(blocks[0]["text"], "look");
    assert_eq!(blocks[1]["type"], "text");
    assert_eq!(blocks[1]["text"], "[Unsupported Image]");
    drop(hits);

    let log = state.repo.latest_log().unwrap().unwrap();
    assert_eq!(log.status_code, Some(200));
}
