use crate::knowledge::inject;
use crate::knowledge::retrieve;
use crate::protocol::types::ChatRequest;
use crate::proxy::state::AppState;
use axum::http::HeaderMap;
use std::time::Duration;

const RETRIEVE_TOP_N: usize = 5;
const CONTEXT_MAX_TOKENS: i64 = 2000;
const RETRIEVE_TIMEOUT: Duration = Duration::from_secs(2);

/// 在请求侧安检之前尝试注入知识库上下文。
///
/// 安全不变量:本函数绝不返回错误、绝不 panic。所有失败路径(RAG 关闭、
/// `x-kb: off`、库缺失/禁用、无 query、检索失败/超时)均 `log::warn!` 后静默返回,
/// 保证 RAG 故障不影响正常聊天。
pub async fn maybe_inject(state: &AppState, headers: &HeaderMap, chat: &mut ChatRequest) {
    let settings = state.rag.read().clone();
    if !settings.enabled {
        return;
    }

    // header `x-kb`:off 显式关闭;有值则按名取库;无值回退 settings.default_kb。
    let kb_name = match headers
        .get("x-kb")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => None,
        Some("off") => return,
        Some(name) => Some(name.to_string()),
    };

    let kb = match kb_name {
        Some(name) => match state.repo.get_kb_by_name(&name) {
            Ok(Some(kb)) => kb,
            Ok(None) => {
                log::warn!("rag: kb '{}' not found, skipping injection", name);
                return;
            }
            Err(e) => {
                log::warn!("rag: kb '{}' lookup failed, skipping injection: {}", name, e);
                return;
            }
        },
        None => match settings.default_kb {
            Some(name) => match state.repo.get_kb_by_name(&name) {
                Ok(Some(kb)) => kb,
                Ok(None) => {
                    log::warn!("rag: default kb '{}' not found, skipping injection", name);
                    return;
                }
                Err(e) => {
                    log::warn!(
                        "rag: default kb '{}' lookup failed, skipping injection: {}",
                        name,
                        e
                    );
                    return;
                }
            },
            None => return,
        },
    };

    if !kb.enabled {
        return;
    }

    let query = match inject::extract_query(chat) {
        Some(q) => q,
        None => return,
    };

    let chunks = match tokio::time::timeout(
        RETRIEVE_TIMEOUT,
        retrieve::retrieve(state, &kb, &query, RETRIEVE_TOP_N),
    )
    .await
    {
        Ok(Ok(chunks)) => chunks,
        Ok(Err(e)) => {
            log::warn!("rag: retrieve failed for kb '{}', skipping injection: {}", kb.name, e);
            return;
        }
        Err(_) => {
            log::warn!("rag: retrieve timed out for kb '{}', skipping injection", kb.name);
            return;
        }
    };

    if let Some(ctx) = inject::build_context_block(&chunks, CONTEXT_MAX_TOKENS) {
        inject::inject_context(chat, &ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::KnowledgeBase;
    use crate::db::Db;
    use crate::protocol::types::ChatMessage;
    use serde_json::json;

    fn chat() -> ChatRequest {
        ChatRequest {
            model: "test-model".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: json!("hello"),
            }],
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: serde_json::Map::new(),
        }
    }

    fn kb(name: &str) -> KnowledgeBase {
        KnowledgeBase {
            id: format!("kb-{name}"),
            name: name.into(),
            description: None,
            embedding_channel_id: None,
            embedding_model: "text-embedding-3-small".into(),
            dim: 4,
            doc_count: 0,
            chunk_count: 0,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn x_kb_off_skips_injection() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.rag.write().enabled = true;

        let mut chat = chat();
        let mut headers = HeaderMap::new();
        headers.insert("x-kb", "off".parse().unwrap());
        maybe_inject(&state, &headers, &mut chat).await;

        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].content, json!("hello"));
    }

    #[tokio::test]
    async fn rag_disabled_skips_injection() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db); // default enabled=false

        let mut chat = chat();
        let headers = HeaderMap::new();
        maybe_inject(&state, &headers, &mut chat).await;

        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].content, json!("hello"));
    }

    #[tokio::test]
    async fn enabled_without_default_kb_skips() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.rag.write().enabled = true; // default_kb None

        let mut chat = chat();
        let headers = HeaderMap::new();
        maybe_inject(&state, &headers, &mut chat).await;

        assert_eq!(chat.messages.len(), 1);
    }

    #[tokio::test]
    async fn x_kb_unknown_skips_injection() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.rag.write().enabled = true;

        let mut chat = chat();
        let mut headers = HeaderMap::new();
        headers.insert("x-kb", "nope".parse().unwrap());
        maybe_inject(&state, &headers, &mut chat).await;

        assert_eq!(chat.messages.len(), 1);
    }

    #[tokio::test]
    async fn no_query_skips_injection() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.rag.write().enabled = true;
        state.rag.write().default_kb = Some("kb1".into());
        state.repo.create_kb(&kb("kb1")).unwrap();

        // 无 user 消息 → extract_query None,不注入也不 panic
        let mut chat = ChatRequest {
            model: "test-model".into(),
            messages: vec![],
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: serde_json::Map::new(),
        };
        let headers = HeaderMap::new();
        maybe_inject(&state, &headers, &mut chat).await;

        assert!(chat.messages.is_empty());
    }
}
