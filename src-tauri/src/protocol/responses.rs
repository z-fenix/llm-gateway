use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// Responses /v1/responses 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages: Vec<ChatMessage> = Vec::new();
    if let Some(instr) = v.get("instructions").and_then(|s| s.as_str()) {
        messages.push(ChatMessage {
            role: "system".into(),
            content: serde_json::Value::String(instr.to_string()),
        });
    }
    match v.get("input") {
        Some(serde_json::Value::String(s)) => {
            messages.push(ChatMessage {
                role: "user".into(),
                content: serde_json::Value::String(s.clone()),
            });
        }
        Some(serde_json::Value::Array(items)) => {
            for it in items {
                let role = it.get("role").and_then(|r| r.as_str());
                let is_msg = it.get("type").and_then(|t| t.as_str()) == Some("message") || role.is_some();
                if !is_msg {
                    continue;
                }
                let mut text = String::new();
                if let Some(parts) = it.get("content").and_then(|c| c.as_array()) {
                    for p in parts {
                        if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                        }
                    }
                } else if let Some(c) = it.get("content").and_then(|c| c.as_str()) {
                    text = c.to_string();
                }
                messages.push(ChatMessage {
                    role: role.unwrap_or("user").to_string(),
                    content: serde_json::Value::String(text),
                });
            }
        }
        _ => {}
    }
    // 仅映射 function 工具为 chat tools,其余类型忽略(最小适配)
    let tools = v
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    if t.get("type").and_then(|x| x.as_str()) == Some("function") {
                        Some(serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": t.get("name").cloned().unwrap_or(serde_json::Value::Null),
                                "description": t.get("description").cloned().unwrap_or(serde_json::Value::Null),
                                "parameters": t.get("parameters").cloned().unwrap_or(serde_json::json!({})),
                            }
                        }))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<serde_json::Value>| !v.is_empty())
        .map(serde_json::Value::Array);
    Ok(ChatRequest {
        model,
        messages,
        max_tokens: v.get("max_output_tokens").and_then(|t| t.as_u64()).map(|t| t as u32),
        stream: v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false),
        temperature: v.get("temperature").and_then(|t| t.as_f64()).map(|t| t as f32),
        tools,
        extra: Default::default(),
    })
}

/// 提取 ChatResponse 文本(content 可能是 string 或其它 JSON)。
pub fn response_text(chat: &ChatResponse) -> String {
    match &chat.content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 统一 ChatResponse → Responses 响应壳(非流式)。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    let text = response_text(chat);
    serde_json::json!({
        "id": format!("resp_{}", uuid::Uuid::new_v4()),
        "object": "response",
        "status": "completed",
        "model": chat.model,
        "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": text }]
        }],
        "usage": {
            "input_tokens": chat.input_tokens,
            "output_tokens": chat.output_tokens,
            "total_tokens": chat.input_tokens + chat.output_tokens
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_req_maps_instructions_and_input_string() {
        let v = serde_json::json!({"model":"gpt-x","instructions":"you are helpful","input":"hi","max_output_tokens":64,"stream":false});
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "gpt-x");
        assert_eq!(chat.messages[0].role, "system");
        assert_eq!(chat.messages[1].role, "user");
        assert_eq!(chat.max_tokens, Some(64));
        assert!(!chat.stream);
    }

    #[test]
    fn responses_req_maps_input_array_and_function_tools() {
        let v = serde_json::json!({"model":"m","input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}
        ],"tools":[{"type":"function","name":"f","description":"d","parameters":{}}]});
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].content, serde_json::json!("hello"));
        let tools = chat.tools.unwrap();
        assert_eq!(tools[0]["function"]["name"], serde_json::json!("f"));
    }

    #[test]
    fn responses_resp_shape() {
        let chat = crate::protocol::types::ChatResponse {
            id: "x".into(), model: "m".into(), content: serde_json::json!("answer"),
            stop_reason: Some("stop".into()), input_tokens: 3, output_tokens: 5, raw: serde_json::json!({}),
        };
        let out = chat_to_response(&chat);
        assert_eq!(out["object"], serde_json::json!("response"));
        assert_eq!(out["output"][0]["content"][0]["text"], serde_json::json!("answer"));
        assert_eq!(out["usage"]["total_tokens"], serde_json::json!(8));
    }
}
