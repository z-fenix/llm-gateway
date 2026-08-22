use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// Anthropic /v1/messages 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages: Vec<ChatMessage> = Vec::new();
    // system 提升为 system message
    if let Some(sys) = v.get("system") {
        let content = match sys {
            serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
            other => other.clone(),
        };
        messages.push(ChatMessage {
            role: "system".into(),
            content,
        });
    }
    if let Some(arr) = v.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            let role = m
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("user")
                .to_string();
            let content = m.get("content").cloned().unwrap_or(serde_json::Value::Null);
            messages.push(ChatMessage { role, content });
        }
    }
    let max_tokens = v
        .get("max_tokens")
        .and_then(|t| t.as_u64())
        .map(|t| t as u32);
    let stream = v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let temperature = v
        .get("temperature")
        .and_then(|t| t.as_f64())
        .map(|t| t as f32);
    let tools = v.get("tools").cloned();
    Ok(ChatRequest {
        model,
        messages,
        max_tokens,
        stream,
        temperature,
        tools,
        extra: Default::default(),
    })
}

/// 统一 ChatRequest → Anthropic 上游请求体（发往 Anthropic 渠道时）。
pub fn chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value {
    let mut system = serde_json::Value::Null;
    let mut messages = Vec::new();
    for m in &chat.messages {
        if m.role == "system" {
            system = m.content.clone();
        } else {
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": chat.max_tokens.unwrap_or(4096),
        "stream": chat.stream,
    });
    if !system.is_null() {
        body["system"] = system;
    }
    if let Some(t) = chat.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = &chat.tools {
        body["tools"] = tools.clone();
    }
    body
}

/// 统一 ChatResponse → Anthropic 响应壳。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    serde_json::json!({
        "id": chat.id,
        "type": "message",
        "role": "assistant",
        "model": chat.model,
        "content": chat.content,
        "stop_reason": chat.stop_reason,
        "usage": { "input_tokens": chat.input_tokens, "output_tokens": chat.output_tokens }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_req_to_chat_lifts_system() {
        let v = serde_json::json!({
            "model": "claude-sonnet-4", "max_tokens": 1024, "stream": true,
            "system": "you are helpful",
            "messages": [{"role":"user","content":"hi"}]
        });
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "claude-sonnet-4");
        assert_eq!(chat.max_tokens, Some(1024));
        assert!(chat.stream);
        assert_eq!(chat.messages[0].role, "system");
        assert_eq!(chat.messages[1].role, "user");
    }

    #[test]
    fn chat_to_anthropic_upstream_restores_system() {
        let v = serde_json::json!({
            "model": "claude-sonnet-4", "max_tokens": 100,
            "system": "sys", "messages": [{"role":"user","content":"hi"}]
        });
        let chat = request_to_chat(&v).unwrap();
        let up = chat_request_to_upstream(&chat, "claude-sonnet-4-20250514");
        assert_eq!(up["model"], "claude-sonnet-4-20250514");
        assert_eq!(up["system"], "sys");
        assert_eq!(up["max_tokens"], 100);
        assert_eq!(up["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn missing_model_errors() {
        let v = serde_json::json!({"messages": []});
        assert!(request_to_chat(&v).is_err());
    }
}
