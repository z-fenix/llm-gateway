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

/// 起一个返回固定响应的 mock /v1/chat/completions + /v1/messages，返回 base_url。
pub async fn spawn_mock(status: u16, body: Value) -> (String, MockUpstream) {
    let state = MockUpstream {
        hits: Arc::new(Mutex::new(vec![])),
        respond_status: Arc::new(Mutex::new(status)),
        respond_body: Arc::new(Mutex::new(body)),
    };
    let _s = state.clone();
    let app = Router::new()
        .route("/v1/chat/completions", post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
            let s = st.0.clone();
            async move {
                s.hits.lock().unwrap().push(v);
                let status = *s.respond_status.lock().unwrap();
                let body = s.respond_body.lock().unwrap().clone();
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(body))
            }
        }))
        .route("/v1/messages", post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
            let s = st.0.clone();
            async move {
                s.hits.lock().unwrap().push(v);
                let status = *s.respond_status.lock().unwrap();
                let body = s.respond_body.lock().unwrap().clone();
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(body))
            }
        }))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{}", addr), state)
}
