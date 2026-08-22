use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// OpenAI /v1/chat/completions 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages = Vec::new();
    if let Some(arr) = v.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            messages.push(ChatMessage {
                role: m
                    .get("role")
                    .and_then(|r| r.as_str())
                    .unwrap_or("user")
                    .to_string(),
                content: m.get("content").cloned().unwrap_or(serde_json::Value::Null),
            });
        }
    }
    Ok(ChatRequest {
        model,
        messages,
        max_tokens: v
            .get("max_tokens")
            .and_then(|t| t.as_u64())
            .map(|t| t as u32),
        stream: v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false),
        temperature: v
            .get("temperature")
            .and_then(|t| t.as_f64())
            .map(|t| t as f32),
        tools: v.get("tools").cloned(),
        extra: Default::default(),
    })
}

/// 统一 ChatRequest → OpenAI 上游请求体。
pub fn chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": chat.messages,
        "stream": chat.stream,
    });
    if let Some(t) = chat.max_tokens {
        body["max_tokens"] = serde_json::json!(t);
    }
    if let Some(t) = chat.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = &chat.tools {
        body["tools"] = tools.clone();
    }
    body
}

/// 统一 ChatResponse → OpenAI 响应壳。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    serde_json::json!({
        "id": chat.id,
        "object": "chat.completion",
        "model": chat.model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": chat.content },
            "finish_reason": chat.stop_reason
        }],
        "usage": {
            "prompt_tokens": chat.input_tokens,
            "completion_tokens": chat.output_tokens,
            "total_tokens": chat.input_tokens + chat.output_tokens
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_req_roundtrip() {
        let v = serde_json::json!({
            "model": "gpt-4o", "stream": true,
            "messages": [{"role":"user","content":"hello"}]
        });
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "gpt-4o");
        assert!(chat.stream);
        let up = chat_request_to_upstream(&chat, "gpt-4o-2024-08-06");
        assert_eq!(up["model"], "gpt-4o-2024-08-06");
        assert_eq!(up["stream"], true);
    }
}
