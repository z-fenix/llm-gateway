mod common;

use axum::{routing::post, Router};
use futures::stream;
use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

async fn spawn_sse_upstream() -> String {
    let app = Router::new().route("/v1/chat/completions", post(|| async {
        let chunks = vec![
            Ok::<_, std::convert::Infallible>(r#"data: {"choices":[{"delta":{"content":"he"}}]}"#.to_string() + "\n\n"),
            Ok(r#"data: {"choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}"#.to_string() + "\n\n"),
            Ok("data: [DONE]".to_string() + "\n\n"),
        ];
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

async fn spawn_split_chunk_upstream() -> String {
    let app = Router::new().route("/v1/chat/completions", post(|| async {
        let line = r#"data: {"choices":[{"delta":{"content":"x"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}"# .to_string() + "\n\n";
        let split_at = line.len() / 2;
        let chunks = vec![
            Ok::<_, std::convert::Infallible>(line[..split_at].to_string()),
            Ok(line[split_at..].to_string()),
        ];
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

async fn spawn_error_upstream() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = socket.read(&mut buf).await;
        let body = r#"data: {"choices":[{"delta":{"content":"he"}}]}"#;
        let chunk = format!("{:X}\r\n{}\r\n", body.len(), body);
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{}",
            chunk
        );
        let _ = socket.write_all(response.as_bytes()).await;
        // Abruptly close without the terminating 0-length chunk, forcing reqwest body-stream error.
        let _ = socket.shutdown().await;
    });
    format!("http://{}", addr)
}

async fn spawn_utf8_split_upstream() -> String {
    let app = Router::new().route("/v1/chat/completions", post(|| async {
        let line = (r#"data: {"choices":[{"delta":{"content":"中"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}"#.to_string() + "\n\n").into_bytes();
        // Split inside the UTF-8 sequence of "中" (E4 B8 AD) so a multi-byte char straddles chunks.
        let split_at = line.windows(3).position(|w| w == [0xE4, 0xB8, 0xAD]).unwrap() + 1;
        let chunks = vec![
            Ok::<_, std::convert::Infallible>(bytes::Bytes::copy_from_slice(&line[..split_at])),
            Ok(bytes::Bytes::copy_from_slice(&line[split_at..])),
        ];
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

fn make_state(base_url: String) -> AppState {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&Channel {
        id: "c1".into(),
        name: "c1".into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: base_url,
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
    })
    .unwrap();
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
    repo.upsert_role_route(&RoleRoute {
        id: "r1".into(),
        role: "sonnet".into(),
        channel_id: "c1".into(),
        target_model: "deepseek-v4-flash".into(),
        enabled: true,
        updated_at: 1,
    })
    .unwrap();
    AppState::new(db)
}

#[tokio::test]
async fn stream_passthrough_and_usage_logged() {
    let base = spawn_sse_upstream().await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    let text = resp.text().await.unwrap();
    assert!(text.contains("he"));
    assert!(text.contains("[DONE]"));

    // usage 已入库（7 + 2）
    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.input_tokens, 7);
    assert_eq!(log.output_tokens, 2);
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 9);
}

#[tokio::test]
async fn stream_split_chunk_usage_accumulated() {
    let base = spawn_split_chunk_upstream().await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    assert!(text.contains(r#""content":"x""#));

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.input_tokens, 3);
    assert_eq!(log.output_tokens, 4);
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 7);
}

#[tokio::test]
async fn stream_upstream_error_logs_failure_and_skips_quota() {
    let base = spawn_error_upstream().await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    // Upstream body stream error may cause client body collection to fail; ignore it.
    let _ = resp.text().await;

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert_ne!(log.status_code, Some(200));
    assert!(log.error.is_some());
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 0);
}

#[tokio::test]
async fn stream_forward_failure_logs_request_log() {
    let (base, _mock) = common::spawn_mock(503, serde_json::json!({"error": "unavailable"})).await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 503);

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert!(log.is_stream);
    assert_eq!(log.status_code, Some(503));
    assert!(log.error.is_some());
    assert_eq!(log.request_model.as_deref(), Some("claude-sonnet-4"));
    assert_eq!(log.role.as_deref(), Some("sonnet"));
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 0);
}

#[tokio::test]
async fn stream_split_utf8_usage_accumulated() {
    let base = spawn_utf8_split_upstream().await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    assert!(text.contains(r#""content":"中""#));

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.input_tokens, 3);
    assert_eq!(log.output_tokens, 4);
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 7);
}

async fn spawn_midstream_error_upstream() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = socket.read(&mut buf).await;
        let body = r#"data: {"choices":[{"delta":{"content":"he"}}]}"#;
        let chunk = format!("{:X}\r\n{}\r\n", body.len(), body);
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{}",
            chunk
        );
        let _ = socket.write_all(response.as_bytes()).await;
        // Close without the terminating 0-length chunk, forcing a mid-stream reqwest body error.
        let _ = socket.shutdown().await;
    });
    format!("http://{}", addr)
}

#[tokio::test]
async fn stream_oversize_line_does_not_hang() {
    let marker = "OVERSIZE_MARKER";
    let big = marker.to_string() + &"x".repeat(1024 * 1024 + 100);
    let chunks = vec![
        big,
        "data: {\"choices\":[{\"delta\":{\"content\":\"after\"}}]}\n\n".to_string(),
    ];
    let (base, _mock) = common::spawn_mock_stream(chunks).await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    // The oversized partial line is dropped from the accumulator buffer to bound memory,
    // but normal complete lines are still forwarded.
    assert!(text.contains("after"));

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 0);
}

#[tokio::test]
async fn stream_mid_error_emits_error_chunk() {
    let base = spawn_midstream_error_upstream().await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    // Gateway should emit an OpenAI-style error event chunk instead of silently producing empty output.
    assert!(text.contains(r#"data: {"error": {"message": "upstream stream error"}}"#));

    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert!(log.is_stream);
    assert_ne!(log.status_code, Some(200));
    assert!(log.error.is_some());
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 0);
}
