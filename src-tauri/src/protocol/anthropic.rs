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
/// Anthropic Message 的 content 必须是内容块数组（Claude Code 按 schema 校验，
/// 字符串 content 会被拒收为 "not a Message"），因此这里做归一化：
/// - OpenAI 字符串 content → [text 块]；Anthropic 数组 content 原样透传；
/// - OpenAI tool_calls → tool_use 块（非流式响应不能丢工具调用）；
/// - OpenAI finish_reason → Anthropic stop_reason（Anthropic 原值不受影响）。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    let mut content: Vec<serde_json::Value> = match &chat.content {
        serde_json::Value::String(s) => {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![serde_json::json!({"type": "text", "text": s})]
            }
        }
        serde_json::Value::Array(arr) => arr.clone(),
        serde_json::Value::Null => Vec::new(),
        other => vec![serde_json::json!({"type": "text", "text": other.to_string()})],
    };
    if let Some(tcs) = chat
        .raw
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("tool_calls"))
        .and_then(|t| t.as_array())
    {
        for tc in tcs {
            let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let name = tc
                .pointer("/function/name")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let args_str = tc
                .pointer("/function/arguments")
                .and_then(|x| x.as_str())
                .unwrap_or("{}");
            let input: serde_json::Value =
                serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
            content.push(
                serde_json::json!({"type": "tool_use", "id": id, "name": name, "input": input}),
            );
        }
    }
    let stop_reason = chat.stop_reason.as_deref().map(|r| match r {
        "stop" | "content_filter" => "end_turn",
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        other => other,
    });
    let mut usage = serde_json::json!({
        "input_tokens": chat.input_tokens,
        "output_tokens": chat.output_tokens,
    });
    if chat.cache_read_tokens > 0 {
        usage["cache_read_input_tokens"] = serde_json::json!(chat.cache_read_tokens);
    }
    if chat.cache_creation_tokens > 0 {
        usage["cache_creation_input_tokens"] = serde_json::json!(chat.cache_creation_tokens);
    }
    serde_json::json!({
        "id": chat.id,
        "type": "message",
        "role": "assistant",
        "model": chat.model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": serde_json::Value::Null,
        "usage": usage,
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

    fn resp(
        content: serde_json::Value,
        stop: Option<&str>,
        raw: serde_json::Value,
    ) -> ChatResponse {
        ChatResponse {
            id: "chatcmpl-1".into(),
            model: "deepseek-v4-flash".into(),
            content,
            stop_reason: stop.map(|s| s.to_string()),
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 3,
            cache_creation_tokens: 2,
            raw,
        }
    }

    #[test]
    fn chat_to_response_wraps_string_content_into_text_block() {
        let chat = resp(
            serde_json::json!("hello world"),
            Some("stop"),
            serde_json::json!({"choices":[]}),
        );
        let out = chat_to_response(&chat);
        assert_eq!(out["type"], "message");
        assert_eq!(out["role"], "assistant");
        assert_eq!(
            out["content"],
            serde_json::json!([{"type": "text", "text": "hello world"}])
        );
        assert_eq!(out["stop_reason"], "end_turn");
        assert!(out["stop_sequence"].is_null());
        assert_eq!(out["usage"]["input_tokens"], 10);
        assert_eq!(out["usage"]["output_tokens"], 5);
        assert_eq!(out["usage"]["cache_read_input_tokens"], 3);
        assert_eq!(out["usage"]["cache_creation_input_tokens"], 2);
    }

    #[test]
    fn chat_to_response_keeps_anthropic_content_blocks() {
        let blocks = serde_json::json!([
            {"type": "text", "text": "hi"},
            {"type": "tool_use", "id": "t1", "name": "f", "input": {}}
        ]);
        let chat = resp(blocks.clone(), Some("tool_use"), serde_json::json!({}));
        let out = chat_to_response(&chat);
        // Anthropic 数组 content 原样透传，stop_reason 不被 finish_reason 映射改写
        assert_eq!(out["content"], blocks);
        assert_eq!(out["stop_reason"], "tool_use");
    }

    #[test]
    fn chat_to_response_converts_openai_tool_calls() {
        let chat = resp(
            serde_json::Value::Null,
            Some("tool_calls"),
            serde_json::json!({"choices": [{"message": {"tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "get_weather", "arguments": "{\"city\":\"SF\"}"}}
            ]}}]}),
        );
        let out = chat_to_response(&chat);
        assert_eq!(out["content"][0]["type"], "tool_use");
        assert_eq!(out["content"][0]["id"], "call_1");
        assert_eq!(out["content"][0]["name"], "get_weather");
        assert_eq!(out["content"][0]["input"]["city"], "SF");
        assert_eq!(out["stop_reason"], "tool_use");
    }
}
