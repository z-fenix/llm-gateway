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
        "messages": normalize_messages_for_openai(&chat.messages),
        "stream": chat.stream,
    });
    if chat.stream {
        // OpenAI 兼容流式必须在请求体声明，否则上游 SSE 不会返回 usage
        body["stream_options"] = serde_json::json!({"include_usage": true});
    }
    if let Some(t) = chat.max_tokens {
        body["max_tokens"] = serde_json::json!(t);
    }
    if let Some(t) = chat.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = &chat.tools {
        body["tools"] = normalize_tools_for_openai(tools);
    }
    body
}

/// 把 Anthropic 风格的 tools（input_schema）归一化为 OpenAI 格式（parameters）。
fn normalize_tools_for_openai(tools: &serde_json::Value) -> serde_json::Value {
    if let Some(arr) = tools.as_array() {
        let normalized: Vec<serde_json::Value> = arr
            .iter()
            .map(|t| {
                if t.get("input_schema").is_some() && t.get("parameters").is_none() {
                    let mut inner = serde_json::Map::new();
                    if let Some(name) = t.get("name") {
                        inner.insert("name".to_string(), name.clone());
                    }
                    if let Some(desc) = t.get("description") {
                        inner.insert("description".to_string(), desc.clone());
                    }
                    inner.insert(
                        "parameters".to_string(),
                        t.get("input_schema").cloned().unwrap_or_default(),
                    );
                    let mut out = t.clone();
                    out["function"] = serde_json::Value::Object(inner);
                    // remove input_schema
                    if let serde_json::Value::Object(ref mut map) = out {
                        map.remove("input_schema");
                    }
                    if !matches!(t.get("type"), Some(_)) {
                        out["type"] = serde_json::json!("function");
                    }
                    out
                } else {
                    t.clone()
                }
            })
            .collect();
        serde_json::Value::Array(normalized)
    } else {
        tools.clone()
    }
}

/// 把统一消息列表归一化为 OpenAI Chat Completions 兼容格式。
/// 主要处理 Anthropic 风格的 content block（tool_use / tool_result / image source）。
fn normalize_messages_for_openai(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for m in messages {
        match &m.content {
            serde_json::Value::Array(blocks) => {
                out.extend(normalize_content_blocks(blocks, &m.role));
            }
            _ => {
                out.push(serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                }));
            }
        }
    }
    out
}

fn normalize_content_blocks(
    blocks: &[serde_json::Value],
    role: &str,
) -> Vec<serde_json::Value> {
    if blocks.is_empty() {
        return vec![serde_json::json!({ "role": role, "content": null })];
    }

    // 已是 OpenAI 兼容格式（text / image_url）直接保留
    let all_openai_compatible = blocks.iter().all(|b| {
        matches!(
            b.get("type").and_then(|t| t.as_str()),
            Some("text") | Some("image_url")
        )
    });
    if all_openai_compatible {
        return vec![serde_json::json!({ "role": role, "content": blocks })];
    }

    match role {
        "assistant" => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            let mut tool_calls = Vec::new();
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                            texts.push(s.to_string());
                        }
                    }
                    Some("tool_use") => {
                        if let Some(tc) = convert_tool_use(b) {
                            tool_calls.push(tc);
                        }
                    }
                    Some("image") | Some("input_image") => {
                        if let Some(img) = convert_image_to_openai(b) {
                            images.push(img);
                        }
                    }
                    _ => {}
                }
            }
            let mut msg = serde_json::json!({ "role": "assistant" });
            msg["content"] = build_content(&texts, &images);
            if !tool_calls.is_empty() {
                msg["tool_calls"] = serde_json::Value::Array(tool_calls);
            }
            vec![msg]
        }
        "user" => {
            let mut texts = Vec::new();
            let mut images = Vec::new();
            let mut tool_results = Vec::new();
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                            texts.push(s.to_string());
                        }
                    }
                    Some("tool_result") => tool_results.push(b.clone()),
                    Some("image") | Some("input_image") => {
                        if let Some(img) = convert_image_to_openai(b) {
                            images.push(img);
                        }
                    }
                    _ => {}
                }
            }
            let mut out = Vec::new();
            if !texts.is_empty() || !images.is_empty() {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": build_content(&texts, &images),
                }));
            }
            for tr in tool_results {
                out.push(convert_tool_result(&tr));
            }
            out
        }
        _ => vec![serde_json::json!({ "role": role, "content": blocks })],
    }
}

fn build_content(texts: &[String], images: &[serde_json::Value]) -> serde_json::Value {
    if images.is_empty() {
        if texts.is_empty() {
            serde_json::Value::Null
        } else if texts.len() == 1 {
            serde_json::Value::String(texts[0].clone())
        } else {
            serde_json::Value::String(texts.join(""))
        }
    } else {
        let mut parts: Vec<serde_json::Value> = texts
            .iter()
            .map(|t| serde_json::json!({ "type": "text", "text": t }))
            .collect();
        parts.extend(images.iter().cloned());
        serde_json::Value::Array(parts)
    }
}

fn convert_tool_use(b: &serde_json::Value) -> Option<serde_json::Value> {
    let id = b.get("id").and_then(|v| v.as_str())?;
    let name = b.get("name").and_then(|v| v.as_str())?;
    let input = b.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
    Some(serde_json::json!({
        "id": id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": input.to_string(),
        }
    }))
}

fn convert_tool_result(b: &serde_json::Value) -> serde_json::Value {
    let tool_use_id = b
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let content = match b.get("content") {
        Some(serde_json::Value::String(s)) => serde_json::Value::String(s.clone()),
        Some(serde_json::Value::Array(arr)) => {
            let text = arr
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("");
            serde_json::Value::String(text)
        }
        Some(v) => serde_json::Value::String(v.to_string()),
        None => serde_json::Value::String(String::new()),
    };
    serde_json::json!({
        "role": "tool",
        "tool_call_id": tool_use_id,
        "content": content,
    })
}

fn convert_image_to_openai(b: &serde_json::Value) -> Option<serde_json::Value> {
    // Anthropic: {"type":"image","source":{"type":"base64","media_type":"...","data":"..."}}
    if let Some(source) = b.get("source") {
        let media_type = source
            .get("media_type")
            .and_then(|v| v.as_str())
            .unwrap_or("image/png");
        let data = source.get("data").and_then(|v| v.as_str())?;
        return Some(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", media_type, data) }
        }));
    }
    // input_image: {"type":"input_image","image_url":"data:image/...;base64,..."}
    if let Some(url) = b.get("image_url").and_then(|v| v.as_str()) {
        return Some(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": url }
        }));
    }
    None
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
        assert_eq!(up["stream_options"]["include_usage"], true);
    }

    #[test]
    fn openai_non_stream_does_not_include_stream_options() {
        let v = serde_json::json!({
            "model": "gpt-4o", "stream": false,
            "messages": [{"role":"user","content":"hello"}]
        });
        let chat = request_to_chat(&v).unwrap();
        assert!(!chat.stream);
        let up = chat_request_to_upstream(&chat, "gpt-4o-2024-08-06");
        assert_eq!(up["stream"], false);
        assert!(up.get("stream_options").is_none());
    }

    #[test]
    fn normalize_anthropic_tool_use_to_tool_calls() {
        // Anthropic assistant message with tool_use block → OpenAI tool_calls
        let messages = vec![
            ChatMessage {
                role: "assistant".into(),
                content: serde_json::json!([{
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "get_weather",
                    "input": {"city": "Beijing"}
                }]),
            },
        ];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let tc = up["messages"][0]["tool_calls"].as_array().unwrap();
        assert_eq!(tc.len(), 1);
        assert_eq!(tc[0]["id"], "toolu_01");
        assert_eq!(tc[0]["type"], "function");
        assert_eq!(tc[0]["function"]["name"], "get_weather");
        assert_eq!(tc[0]["function"]["arguments"], "{\"city\":\"Beijing\"}");
        // content should be null (no text blocks)
        assert!(up["messages"][0]["content"].is_null());
    }

    #[test]
    fn normalize_anthropic_tool_result_to_tool_role() {
        // Anthropic user message with tool_result block → OpenAI tool role message
        let messages = vec![
            ChatMessage {
                role: "user".into(),
                content: serde_json::json!([{
                    "type": "tool_result",
                    "tool_use_id": "toolu_01",
                    "content": "sunny"
                }]),
            },
        ];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let msgs = up["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(msgs[0]["tool_call_id"], "toolu_01");
        assert_eq!(msgs[0]["content"], "sunny");
    }

    #[test]
    fn normalize_anthropic_tool_result_array_content() {
        // tool_result with array content (text blocks)
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!([{
                "type": "tool_result",
                "tool_use_id": "toolu_01",
                "content": [{"type": "text", "text": "result data"}]
            }]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let msgs = up["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(msgs[0]["content"], "result data");
    }

    #[test]
    fn normalize_anthropic_mixed_assistant_text_and_tool_use() {
        // assistant with both text and tool_use blocks
        let messages = vec![ChatMessage {
            role: "assistant".into(),
            content: serde_json::json!([
                {"type": "text", "text": "let me check"},
                {"type": "tool_use", "id": "t1", "name": "search", "input": {"q": "x"}}
            ]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let msg = &up["messages"][0];
        assert_eq!(msg["content"], "let me check");
        assert_eq!(msg["tool_calls"][0]["function"]["name"], "search");
    }

    #[test]
    fn normalize_anthropic_image_to_openai_image_url() {
        // Anthropic image block → OpenAI image_url
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!([{
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "abc123"}
            }]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let parts = up["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image_url");
        assert!(parts[0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn openai_compatible_content_blocks_preserved() {
        // Already OpenAI-compatible blocks pass through unchanged
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!([
                {"type": "text", "text": "hello"},
                {"type": "image_url", "image_url": {"url": "http://x.png"}}
            ]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let parts = up["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image_url");
    }

    #[test]
    fn normalize_user_text_and_tool_result_separate_messages() {
        // user with both text and tool_result → two separate messages
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!([
                {"type": "text", "text": "what is the weather?"},
                {"type": "tool_result", "tool_use_id": "t1", "content": "sunny"}
            ]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let msgs = up["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "what is the weather?");
        assert_eq!(msgs[1]["role"], "tool");
        assert_eq!(msgs[1]["tool_call_id"], "t1");
        assert_eq!(msgs[1]["content"], "sunny");
    }

    #[test]
    fn normalize_empty_content_array() {
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!([]),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        assert_eq!(up["messages"][0]["role"], "user");
        assert!(up["messages"][0]["content"].is_null());
    }

    #[test]
    fn normalize_anthropic_input_schema_to_parameters() {
        // Anthropic: {name, description, input_schema} → OpenAI: {type:function, function:{name, description, parameters}}
        let tools = serde_json::json!([
            {
                "name": "get_weather",
                "description": "查询天气",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"]
                }
            }
        ]);
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!("what's the weather in Beijing?"),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: Some(tools),
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let t = &up["tools"][0];
        assert_eq!(t["type"], "function");
        assert_eq!(t["function"]["name"], "get_weather");
        assert_eq!(t["function"]["description"], "查询天气");
        assert!(t.get("input_schema").is_none());
        assert_eq!(
            t["function"]["parameters"],
            serde_json::json!({
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"]
            })
        );
    }

    #[test]
    fn openai_tools_already_have_parameters_unchanged() {
        // OpenAI-style tools (with parameters) pass through unchanged
        let tools = serde_json::json!([{
            "type": "function",
            "function": {
                "name": "search",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
            }
        }]);
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: serde_json::json!("hello"),
        }];
        let chat = ChatRequest {
            model: "gpt-4o".into(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: Some(tools),
            extra: Default::default(),
        };
        let up = chat_request_to_upstream(&chat, "gpt-4o");
        let t = &up["tools"][0];
        assert_eq!(t["function"]["name"], "search");
        assert_eq!(t["type"], "function");
        assert!(t.get("input_schema").is_none());
    }
}
