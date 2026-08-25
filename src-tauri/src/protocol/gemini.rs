use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// Gemini Native generateContent/streamGenerateContent 请求体 → 统一 ChatRequest。
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
    if let Some(sys) = v
        .get("systemInstruction")
        .and_then(|s| s.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
    {
        messages.push(ChatMessage {
            role: "system".into(),
            content: serde_json::Value::String(sys.to_string()),
        });
    }
    if let Some(arr) = v.get("contents").and_then(|c| c.as_array()) {
        for it in arr {
            let role = it.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let role = if role == "model" { "assistant" } else { role };
            let mut text = String::new();
            if let Some(parts) = it.get("parts").and_then(|p| p.as_array()) {
                for p in parts {
                    if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            messages.push(ChatMessage {
                role: role.to_string(),
                content: serde_json::Value::String(text),
            });
        }
    }
    let gen_cfg = v.get("generationConfig").cloned().unwrap_or_default();
    Ok(ChatRequest {
        model,
        messages,
        max_tokens: gen_cfg
            .get("maxOutputTokens")
            .and_then(|t| t.as_u64())
            .map(|t| t as u32),
        stream: false,
        temperature: gen_cfg
            .get("temperature")
            .and_then(|t| t.as_f64())
            .map(|t| t as f32),
        tools: None,
        extra: Default::default(),
    })
}

/// 统一 ChatRequest → Gemini Native 上游请求体。
pub fn chat_request_to_upstream(chat: &ChatRequest, _model: &str) -> serde_json::Value {
    let mut system = String::new();
    let mut contents = Vec::new();
    for m in &chat.messages {
        if m.role == "system" {
            if let serde_json::Value::String(s) = &m.content {
                system.push_str(s);
            } else if let Some(s) = m.content.as_str() {
                system.push_str(s);
            } else {
                system.push_str(&m.content.to_string());
            }
            continue;
        }
        let role = if m.role == "assistant" {
            "model"
        } else {
            "user"
        };
        let text = match &m.content {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        contents.push(serde_json::json!({
            "role": role,
            "parts": [{"text": text}]
        }));
    }
    let mut body = serde_json::json!({
        "contents": contents,
    });
    if !system.is_empty() {
        body["systemInstruction"] = serde_json::json!({ "parts": [{"text": system}] });
    }
    let mut gen_cfg = serde_json::Map::new();
    if let Some(t) = chat.max_tokens {
        gen_cfg.insert("maxOutputTokens".into(), serde_json::json!(t));
    }
    if let Some(t) = chat.temperature {
        gen_cfg.insert("temperature".into(), serde_json::json!(t));
    }
    if !gen_cfg.is_empty() {
        body["generationConfig"] = serde_json::Value::Object(gen_cfg);
    }
    body
}

/// 提取 ChatResponse 文本（Gemini 响应 candidate 中的 text 部分）。
pub fn response_text(v: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(cands) = v.get("candidates").and_then(|c| c.as_array()) {
        for c in cands {
            if let Some(parts) = c
                .get("content")
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
            {
                for p in parts {
                    if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
            }
        }
    }
    out
}

/// 统一 ChatResponse → Gemini Native 响应壳（非流式）。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    let text = match &chat.content {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    serde_json::json!({
        "candidates": [{
            "content": {
                "role": "model",
                "parts": [{"text": text}]
            },
            "finishReason": chat.stop_reason.clone().unwrap_or_else(|| "STOP".into())
        }],
        "usageMetadata": {
            "promptTokenCount": chat.input_tokens,
            "candidatesTokenCount": chat.output_tokens,
            "totalTokenCount": chat.input_tokens + chat.output_tokens
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_req_to_chat_maps_system_and_roles() {
        let v = serde_json::json!({
            "model": "gemini-pro",
            "systemInstruction": {"parts": [{"text": "you are helpful"}]},
            "contents": [
                {"role": "user", "parts": [{"text": "hi"}]},
                {"role": "model", "parts": [{"text": "hello"}]}
            ],
            "generationConfig": {"maxOutputTokens": 64, "temperature": 0.5}
        });
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "gemini-pro");
        assert_eq!(chat.messages[0].role, "system");
        assert_eq!(chat.messages[1].role, "user");
        assert_eq!(chat.messages[2].role, "assistant");
        assert_eq!(chat.max_tokens, Some(64));
        assert_eq!(chat.temperature, Some(0.5));
    }

    #[test]
    fn chat_to_gemini_upstream_restores_system_and_model_role() {
        let chat = ChatRequest {
            model: "gemini-pro".into(),
            messages: vec![
                ChatMessage {
                    role: "system".into(),
                    content: serde_json::json!("sys"),
                },
                ChatMessage {
                    role: "user".into(),
                    content: serde_json::json!("hi"),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: serde_json::json!("hello"),
                },
            ],
            max_tokens: Some(100),
            stream: false,
            temperature: Some(0.7),
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gemini-pro-001");
        // model 只出现在 URL 中，不在 Gemini Native 请求体里
        assert!(up.get("model").is_none());
        assert_eq!(up["systemInstruction"]["parts"][0]["text"], "sys");
        assert_eq!(up["contents"].as_array().unwrap().len(), 2);
        assert_eq!(up["contents"][0]["role"], "user");
        assert_eq!(up["contents"][1]["role"], "model");
        assert_eq!(up["generationConfig"]["maxOutputTokens"], 100);
        assert!((up["generationConfig"]["temperature"].as_f64().unwrap() - 0.7).abs() < 0.001);
    }

    #[test]
    fn chat_to_response_shape() {
        let chat = ChatResponse {
            id: "x".into(),
            model: "m".into(),
            content: serde_json::json!("answer"),
            stop_reason: Some("stop".into()),
            input_tokens: 3,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            raw: serde_json::json!({}),
        };
        let out = chat_to_response(&chat);
        assert_eq!(
            out["candidates"][0]["content"]["parts"][0]["text"],
            "answer"
        );
        assert_eq!(out["usageMetadata"]["totalTokenCount"], 8);
    }
}
