#![allow(dead_code)]

use axum::{extract::State, routing::post, Json, Router};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct MockUpstream {
    pub hits: Arc<Mutex<Vec<Value>>>,
    pub respond_status: Arc<Mutex<u16>>,
    pub respond_body: Arc<Mutex<Value>>,
}

/// 固定返回 4 维向量的 mock /v1/embeddings 上游。
/// `respond_status` 可在测试运行中改为 500 以模拟 embedding 故障。
#[derive(Clone, Default)]
pub struct EmbeddingMock {
    pub hits: Arc<Mutex<Vec<Value>>>,
    pub respond_status: Arc<Mutex<u16>>,
}

/// 组合聊天上游 + embedding 上游的 mock 句柄。
#[derive(Clone, Default)]
pub struct MockWithEmbeddings {
    pub chat: MockUpstream,
    pub embeddings: EmbeddingMock,
}

/// 起一个返回固定响应的 mock /v1/chat/completions + /v1/messages，返回 base_url。
pub async fn spawn_mock(status: u16, body: Value) -> (String, MockUpstream) {
    let state = MockUpstream {
        hits: Arc::new(Mutex::new(vec![])),
        respond_status: Arc::new(Mutex::new(status)),
        respond_body: Arc::new(Mutex::new(body)),
    };
    let _s = state.clone();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
                let s = st.0.clone();
                async move {
                    s.hits.lock().unwrap().push(v);
                    let status = *s.respond_status.lock().unwrap();
                    let body = s.respond_body.lock().unwrap().clone();
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(body),
                    )
                }
            }),
        )
        .route(
            "/v1/messages",
            post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
                let s = st.0.clone();
                async move {
                    s.hits.lock().unwrap().push(v);
                    let status = *s.respond_status.lock().unwrap();
                    let body = s.respond_body.lock().unwrap().clone();
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        Json(body),
                    )
                }
            }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{}", addr), state)
}

/// 起一个 mock 聊天上游(复用 `spawn_mock`)+ 一个返回固定 4 维向量的 mock `/v1/embeddings`。
/// 返回 `(chat_base_url, embeddings_base_url, mocks)`。
/// embeddings 路由按 `input` 数组长度返回等量 `data[{index, embedding:[0.5;4]}]`，
/// 并记录 hits；`embedding_status != 200` 时返回错误体(供降级场景切换)。
pub async fn spawn_mock_with_embeddings(
    chat_status: u16,
    chat_body: Value,
    embedding_status: u16,
) -> (String, String, MockWithEmbeddings) {
    let (chat_base, chat) = spawn_mock(chat_status, chat_body).await;
    let embeddings = EmbeddingMock {
        hits: Arc::new(Mutex::new(vec![])),
        respond_status: Arc::new(Mutex::new(embedding_status)),
    };
    let app = Router::new()
        .route(
            "/v1/embeddings",
            post(move |st: State<EmbeddingMock>, Json(v): Json<Value>| {
                let s = st.0.clone();
                async move {
                    s.hits.lock().unwrap().push(v.clone());
                    let status = *s.respond_status.lock().unwrap();
                    if status == 200 {
                        let input = v["input"].as_array().cloned().unwrap_or_default();
                        let data: Vec<Value> = input
                            .iter()
                            .enumerate()
                            .map(|(i, _)| {
                                serde_json::json!({
                                    "object": "embedding",
                                    "index": i,
                                    "embedding": [0.5, 0.5, 0.5, 0.5]
                                })
                            })
                            .collect();
                        (
                            axum::http::StatusCode::OK,
                            Json(serde_json::json!({ "object": "list", "data": data })),
                        )
                    } else {
                        (
                            axum::http::StatusCode::from_u16(status).unwrap(),
                            Json(serde_json::json!({ "error": "boom" })),
                        )
                    }
                }
            }),
        )
        .with_state(embeddings.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        chat_base,
        format!("http://{}", addr),
        MockWithEmbeddings { chat, embeddings },
    )
}

/// 起一个返回 SSE 流式响应的 mock /v1/chat/completions + /v1/messages。
/// `chunks` 为完整的 SSE 事件字符串（通常以 \n\n 分隔），会按原样发送。
pub async fn spawn_mock_stream(chunks: Vec<String>) -> (String, MockUpstream) {
    let chunks = Arc::new(chunks);
    let state = MockUpstream {
        hits: Arc::new(Mutex::new(vec![])),
        respond_status: Arc::new(Mutex::new(200)),
        respond_body: Arc::new(Mutex::new(Value::Null)),
    };
    let completions_chunks = chunks.clone();
    let messages_chunks = chunks.clone();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
                let s = st.0.clone();
                let chunks = completions_chunks.clone();
                async move {
                    s.hits.lock().unwrap().push(v);
                    let body_chunks: Vec<String> = chunks.to_vec();
                    axum::response::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from_stream(futures::stream::iter(
                            body_chunks
                                .into_iter()
                                .map(|c| Ok::<_, std::convert::Infallible>(c)),
                        )))
                        .unwrap()
                }
            }),
        )
        .route(
            "/v1/messages",
            post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
                let s = st.0.clone();
                let chunks = messages_chunks.clone();
                async move {
                    s.hits.lock().unwrap().push(v);
                    let body_chunks: Vec<String> = chunks.to_vec();
                    axum::response::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from_stream(futures::stream::iter(
                            body_chunks
                                .into_iter()
                                .map(|c| Ok::<_, std::convert::Infallible>(c)),
                        )))
                        .unwrap()
                }
            }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{}", addr), state)
}
