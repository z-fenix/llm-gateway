use crate::proxy::handlers;
use crate::proxy::state::AppState;
use axum::{routing::{get, post}, Router};
use std::net::SocketAddr;
use std::sync::Mutex;

static BOUND: Mutex<Option<SocketAddr>> = Mutex::new(None);

pub fn bound_addr() -> Option<SocketAddr> {
    *BOUND.lock().unwrap()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/v1/models", get(handlers::list_models))
        .route("/v1/chat/completions", post(handlers::openai_chat))
        .route("/v1/messages", post(handlers::anthropic_messages))
        .with_state(state)
}

pub async fn start(state: AppState, port: u16) -> tokio::task::JoinHandle<()> {
    let app = router(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = std::net::TcpListener::bind(addr).expect("bind gateway");
    listener.set_nonblocking(true).expect("set nonblocking");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    let local = listener.local_addr().unwrap();
    {
        let mut b = BOUND.lock().unwrap();
        *b = Some(local);
    }
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve gateway");
    })
}
