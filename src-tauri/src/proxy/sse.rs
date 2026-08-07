#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// 从 OpenAI chunk 的 usage 字段提取（若存在）。
pub fn extract_openai_usage(v: &serde_json::Value) -> Option<Usage> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }
    let input = u.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
    let output = u.get("completion_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage { input_tokens: input, output_tokens: output })
}

/// 应用一条 Anthropic SSE 事件到 usage 累积。
pub fn apply_anthropic_event(acc: &mut Usage, v: &serde_json::Value) {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("message_start") => {
            if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                if let Some(i) = u.get("input_tokens").and_then(|t| t.as_u64()) {
                    acc.input_tokens = i;
                }
                if let Some(o) = u.get("output_tokens").and_then(|t| t.as_u64()) {
                    acc.output_tokens = o;
                }
            }
        }
        Some("message_delta") => {
            if let Some(u) = v.get("usage") {
                if let Some(o) = u.get("output_tokens").and_then(|t| t.as_u64()) {
                    acc.output_tokens = o; // Anthropic 在 delta 里给累计值
                }
            }
        }
        _ => {}
    }
}

/// 逐行解析 SSE，按协议累积 usage 与文本内容。
pub struct SseAccumulator {
    usage: Usage,
    protocol: Protocol,
    text: String,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Protocol {
    OpenAI,
    Anthropic,
}

impl SseAccumulator {
    pub fn new(protocol: Protocol) -> Self {
        Self { usage: Usage::default(), protocol, text: String::new() }
    }

    /// 喂入一行原始 SSE 文本（可能是 "data: {...}" 或空行/event 行）。
    pub fn feed_line(&mut self, line: &str) {
        let line = line.trim();
        if !line.starts_with("data:") {
            return;
        }
        let payload = line.trim_start_matches("data:").trim();
        if payload == "[DONE]" || payload.is_empty() {
            return;
        }
        let v: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return,
        };
        match self.protocol {
            Protocol::OpenAI => {
                if let Some(u) = extract_openai_usage(&v) {
                    self.usage = u;
                }
                if let Some(content) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    self.text.push_str(content);
                }
            }
            Protocol::Anthropic => {
                apply_anthropic_event(&mut self.usage, &v);
                if let Some(text) = v
                    .get("content_block_delta")
                    .and_then(|d| d.get("delta"))
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    self.text.push_str(text);
                }
            }
        }
    }

    pub fn usage(&self) -> Usage {
        self.usage
    }

    pub fn text(&self) -> &str {
        &self.text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_usage_from_final_chunk() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#);
        acc.feed_line("data: [DONE]");
        let u = acc.usage();
        assert_eq!(u.input_tokens, 10);
        assert_eq!(u.output_tokens, 5);
    }

    #[test]
    fn anthropic_usage_across_events() {
        let mut acc = SseAccumulator::new(Protocol::Anthropic);
        acc.feed_line(r#"data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#);
        acc.feed_line(r#"data: {"type":"content_block_delta","delta":{"text":"hello"}}"#);
        acc.feed_line(r#"data: {"type":"message_delta","usage":{"output_tokens":12}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 25);
        assert_eq!(u.output_tokens, 12);
    }

    #[test]
    fn ignores_non_data_and_garbage() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line("event: message_start");
        acc.feed_line("");
        acc.feed_line("data: not-json");
        assert_eq!(acc.usage(), Usage::default());
    }
}
