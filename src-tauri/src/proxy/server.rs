use crate::proxy::handlers;
use crate::proxy::state::AppState;
use axum::{routing::{get, post}, Router};
use std::net::SocketAddr;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/v1/models", get(handlers::list_models))
        .route("/v1/chat/completions", post(handlers::openai_chat))
        .route("/v1/messages", post(handlers::anthropic_messages))
        .route("/v1/responses", post(handlers::responses_messages))
        .merge(crate::mcp::mcp_router(state.clone()))
        .with_state(state)
}

pub async fn start(state: AppState, start_port: u16) -> Result<(tokio::task::JoinHandle<()>, SocketAddr), String> {
    let app = router(state);
    let listener = if start_port == 0 {
        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("bind test gateway: {}", e))?
    } else {
        let mut last_err = None;
        let mut listener: Option<tokio::net::TcpListener> = None;
        for port in start_port..=8787 {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => {
                    let bound = l.local_addr().unwrap();
                    if port != start_port {
                        log::warn!("port {} occupied, gateway bound to {}", start_port, bound);
                    } else {
                        log::info!("llm-gateway listening on {}", bound);
                    }
                    listener = Some(l);
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }
        listener.ok_or_else(|| {
            format!(
                "no available port in {}..=8787: {:?}",
                start_port,
                last_err
            )
        })?
    };

    let local = listener.local_addr().unwrap();

    Ok((tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve gateway");
    }), local))
}
