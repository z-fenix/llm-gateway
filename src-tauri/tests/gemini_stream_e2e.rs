mod common;

use axum::{extract::Json, routing::post, Router};
use futures::stream;
use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

/// 起一个返回 Gemini 风格 NDJSON 流式分块的 mock /v1beta/models/gemini-pro:streamGenerateContent。
/// Gemini Native 的 streamGenerateContent 默认返回无 `data:` 前缀的 NDJSON（\r\n\r\n 分隔），
/// upstream_url 会把 channel.base_url 拼上 `/models/{model}:streamGenerateContent?key=...`，
/// 因此这里 base_url 取 mock 根 + `/v1beta`。
async fn spawn_gemini_stream_mock(chunks: Vec<String>) -> String {
    let chunks = std::sync::Arc::new(chunks);
    let app = Router::new().route(
        "/v1beta/models/gemini-pro:streamGenerateContent",
        post({
            let chunks = chunks.clone();
            move |Json(_v): Json<serde_json::Value>| {
                let chunks = chunks.clone();
                async move {
                    axum::response::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from_stream(stream::iter(
                            chunks.to_vec().into_iter().map(|c| {
                                Ok::<_, std::convert::Infallible>(c)
                            }),
                        )))
                        .unwrap()
                }
            }
        }),
    );
    let listener =
        tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

/// 本机测试客户端直连回环地址，与网关内部 client 一样禁用系统代理，
/// 否则 Windows 系统代理会拦截 loopback 请求导致 503。
fn no_proxy_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

fn make_state(base_url: String) -> AppState {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&Channel {
        id: "c1".into(),
        name: "c1".into(),
        supplier: "google".into(),
        upstream_protocol: "gemini-native".into(),
        base_url: base_url + "/v1beta",
        api_key: "AI-mock".into(),
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
    AppState::new(db)
}

#[tokio::test]
async fn gemini_ndjson_stream_text_and_usage_logged() {
    // Gemini Native streamGenerateContent 返回无 data: 前缀的 NDJSON 分块
    let base = spawn_gemini_stream_mock(vec![
        "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello \"}],\"role\":\"model\"}}]}\r\n\r\n".to_string(),
        "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"world\"}],\"role\":\"model\"}}],\"usageMetadata\":{\"promptTokenCount\":3,\"candidatesTokenCount\":2}}\r\n\r\n".to_string(),
    ])
    .await;
    let state = make_state(base);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = no_proxy_client()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"gemini-pro","stream":true,
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
    // 网关原样转发上游 NDJSON chunk，两个分块都应在响应体中
    assert!(text.contains("hello "));
    assert!(text.contains("world"));

    // usage 已入库（3 + 2）
    let repo = Repository::new(state.db);
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.input_tokens, 3);
    assert_eq!(log.output_tokens, 2);
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 5);
}
