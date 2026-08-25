#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// 缓存命中 token（openai 的 cached_tokens / anthropic 的 cache_read_input_tokens / gemini 的 cachedContentTokenCount）
    pub cache_read_tokens: u64,
    /// 缓存写入 token（openai 的 cache_write_tokens / anthropic 的 cache_creation_input_tokens；gemini 恒为 0）
    pub cache_creation_tokens: u64,
}

/// 从 OpenAI chunk 的 usage 字段提取（若存在）。
/// 缓存回退链（对齐 cc-switch）：直传 cache_read_input_tokens → input_tokens_details/cached_tokens → prompt_tokens_details/cached_tokens；
/// 写入 cache_creation_input_tokens → input_tokens_details/cache_write_tokens → prompt_tokens_details/cache_write_tokens。
pub fn extract_openai_usage(v: &serde_json::Value) -> Option<Usage> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }
    let input = u.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
    let output = u
        .get("completion_tokens")
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let cache_read = u
        .get("cache_read_input_tokens")
        .and_then(|t| t.as_u64())
        .or_else(|| {
            u.pointer("/input_tokens_details/cached_tokens")
                .and_then(|t| t.as_u64())
        })
        .or_else(|| {
            u.pointer("/prompt_tokens_details/cached_tokens")
                .and_then(|t| t.as_u64())
        })
        .unwrap_or(0);
    let cache_creation = u
        .get("cache_creation_input_tokens")
        .and_then(|t| t.as_u64())
        .or_else(|| {
            u.pointer("/input_tokens_details/cache_write_tokens")
                .and_then(|t| t.as_u64())
        })
        .or_else(|| {
            u.pointer("/prompt_tokens_details/cache_write_tokens")
                .and_then(|t| t.as_u64())
        })
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
    })
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
                // 缓存字段只在 message_start 一次性给出
                if let Some(c) = u.get("cache_read_input_tokens").and_then(|t| t.as_u64()) {
                    acc.cache_read_tokens = c;
                }
                if let Some(c) = u
                    .get("cache_creation_input_tokens")
                    .and_then(|t| t.as_u64())
                {
                    acc.cache_creation_tokens = c;
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
    Gemini,
}

impl SseAccumulator {
    pub fn new(protocol: Protocol) -> Self {
        Self {
            usage: Usage::default(),
            protocol,
            text: String::new(),
        }
    }

    /// 喂入一行原始 SSE 文本（可能是 "data: {...}"、空行/event 行，
    /// 或 Gemini Native 无 data: 前缀的 NDJSON 行）。
    pub fn feed_line(&mut self, line: &str) {
        let line = line.trim();
        let payload: Option<&str> = if line.starts_with("data:") {
            let p = line.trim_start_matches("data:").trim();
            if p == "[DONE]" || p.is_empty() {
                None
            } else {
                Some(p)
            }
        } else if self.protocol == Protocol::Gemini && !line.is_empty() {
            // Gemini Native streamGenerateContent 默认返回 NDJSON(无 data: 前缀)
            Some(line)
        } else {
            None
        };
        let Some(payload) = payload else { return };
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
            Protocol::Gemini => {
                if let Some(u) = v.get("usageMetadata") {
                    if let Some(i) = u.get("promptTokenCount").and_then(|t| t.as_u64()) {
                        self.usage.input_tokens = i;
                    }
                    if let Some(o) = u.get("candidatesTokenCount").and_then(|t| t.as_u64()) {
                        self.usage.output_tokens = o;
                    }
                    // Gemini 的 promptTokenCount 含缓存命中；cachedContentTokenCount 为缓存读，无缓存写。
                    if let Some(c) = u.get("cachedContentTokenCount").and_then(|t| t.as_u64()) {
                        self.usage.cache_read_tokens = c;
                    }
                }
                if let Some(text) = v
                    .get("candidates")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("content"))
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.get(0))
                    .and_then(|p| p.get("text"))
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
    fn gemini_usage_and_text_across_events() {
        let mut acc = SseAccumulator::new(Protocol::Gemini);
        acc.feed_line(r#"data: {"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 3);
        assert_eq!(u.output_tokens, 2);
        assert_eq!(acc.text(), "hello");
    }

    #[test]
    fn gemini_ndjson_without_data_prefix_parses() {
        let mut acc = SseAccumulator::new(Protocol::Gemini);
        acc.feed_line(r#"{"candidates":[{"content":{"parts":[{"text":"ndjson works"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 3);
        assert_eq!(u.output_tokens, 2);
        assert_eq!(acc.text(), "ndjson works");
    }

    #[test]
    fn gemini_accepts_both_data_prefix_and_ndjson() {
        let mut acc = SseAccumulator::new(Protocol::Gemini);
        acc.feed_line(r#"data: {"candidates":[{"content":{"parts":[{"text":"data "}],"role":"model"}}]}"#);
        acc.feed_line(r#"{"candidates":[{"content":{"parts":[{"text":"ndjson"}],"role":"model"}}]}"#);
        assert_eq!(acc.text(), "data ndjson");
    }

    #[test]
    fn non_gemini_requires_data_prefix() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        // 无 data: 前缀的裸 JSON 行在非 Gemini 协议下必须被忽略
        acc.feed_line(r#"{"choices":[{"delta":{"content":"sneaky"}}]}"#);
        assert_eq!(acc.text(), "");
    }

    #[test]
    fn openai_cache_fallback_chain() {
        // 直传 cache_read_input_tokens / cache_creation_input_tokens 优先
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"cache_read_input_tokens":80,"cache_creation_input_tokens":15}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 50);
        assert_eq!(u.cache_read_tokens, 80);
        assert_eq!(u.cache_creation_tokens, 15);
    }

    #[test]
    fn openai_cache_from_prompt_tokens_details() {
        // 回退链:input_tokens_details/cached_tokens → prompt_tokens_details/cached_tokens
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"input_tokens_details":{"cached_tokens":60}}}"#);
        let u = acc.usage();
        assert_eq!(u.cache_read_tokens, 60);
        assert_eq!(u.cache_creation_tokens, 0);

        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":70,"cache_write_tokens":20}}}"#);
        let u = acc.usage();
        assert_eq!(u.cache_read_tokens, 70);
        assert_eq!(u.cache_creation_tokens, 20);
    }

    #[test]
    fn openai_cache_write_from_input_tokens_details() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"input_tokens_details":{"cache_write_tokens":12}}}"#);
        let u = acc.usage();
        assert_eq!(u.cache_read_tokens, 0);
        assert_eq!(u.cache_creation_tokens, 12);
    }

    #[test]
    fn anthropic_cache_from_message_start() {
        let mut acc = SseAccumulator::new(Protocol::Anthropic);
        acc.feed_line(r#"data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}"#);
        acc.feed_line(r#"data: {"type":"message_delta","usage":{"output_tokens":12}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 25);
        assert_eq!(u.output_tokens, 12);
        assert_eq!(u.cache_read_tokens, 10);
        assert_eq!(u.cache_creation_tokens, 5);
        // message_delta 只带 output_tokens，不覆盖缓存字段
        assert_eq!(u.cache_read_tokens, 10);
    }

    #[test]
    fn gemini_cache_from_cached_content_token_count() {
        let mut acc = SseAccumulator::new(Protocol::Gemini);
        acc.feed_line(r#"{"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":30,"cachedContentTokenCount":40}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 100);
        assert_eq!(u.output_tokens, 30);
        assert_eq!(u.cache_read_tokens, 40);
        assert_eq!(u.cache_creation_tokens, 0, "gemini 无缓存写");
    }
}
