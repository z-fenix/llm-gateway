//! OpenAI chat 流式响应 → Anthropic 流式响应的协议转换。
//!
//! Anthropic 客户端（如 Claude Code）只认 message_start / content_block_* /
//! message_delta / message_stop 事件序列；上游为 openai-chat 时必须把 OpenAI 的
//! delta chunk 转换为 Anthropic SSE 事件再下发，否则客户端收到 0 个有效事件，
//! 直接报 StreamNoEventsError。语义对齐 cc-switch 的 create_anthropic_sse_stream：
//! - finish_reason 只缓存不发，等 [DONE]/流末尾统一发出 message_delta（上游可能
//!   在 finish_reason 之后才补发 usage），且每条流只发一次；
//! - 流异常中断时发 Anthropic error 事件，不伪装成正常完成。

use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

/// 单行超过该长度且无换行时丢弃，防御异常上游。
const MAX_LINE_BYTES: usize = 1024 * 1024;

struct ToolBlockState {
    anthropic_index: u32,
    id: String,
    name: String,
    started: bool,
    /// id/name 到齐前缓存的 arguments 增量
    pending_args: String,
}

/// push 式转换器：喂入上游字节，返回应下发给 Anthropic 客户端的 SSE 字节。
pub struct OpenAiSseToAnthropic {
    buffer: Vec<u8>,
    /// 首个 data: 行之前累积的原始字节（上游违规返回非 SSE JSON body 时兜底合成）
    raw_head: Vec<u8>,
    saw_data_line: bool,
    message_id: String,
    current_model: String,
    next_content_index: u32,
    has_sent_message_start: bool,
    has_emitted_message_delta: bool,
    /// (stop_reason, usage)：延迟到 [DONE]/流末尾发出的 message_delta
    pending_message_delta: Option<(Option<String>, Value)>,
    has_sent_message_stop: bool,
    saw_stream_error: bool,
    /// 当前打开的非工具块 (类型, index)
    current_non_tool: Option<(&'static str, u32)>,
    tool_blocks: HashMap<u64, ToolBlockState>,
    open_tool_blocks: BTreeSet<u32>,
    latest_usage: Option<Value>,
}

impl Default for OpenAiSseToAnthropic {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiSseToAnthropic {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            raw_head: Vec::new(),
            saw_data_line: false,
            message_id: String::new(),
            current_model: String::new(),
            next_content_index: 0,
            has_sent_message_start: false,
            has_emitted_message_delta: false,
            pending_message_delta: None,
            has_sent_message_stop: false,
            saw_stream_error: false,
            current_non_tool: None,
            tool_blocks: HashMap::new(),
            open_tool_blocks: BTreeSet::new(),
            latest_usage: None,
        }
    }

    /// 喂入上游字节，返回转换后的 Anthropic SSE 字节。
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        if !self.saw_data_line {
            self.raw_head.extend_from_slice(bytes);
            if self.raw_head.len() > MAX_LINE_BYTES {
                // 异常超大且无 data: 行：放弃兜底合成
                self.raw_head.clear();
                self.saw_data_line = true;
            }
        }
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            self.process_line(&line, &mut out);
        }
        if self.buffer.len() > MAX_LINE_BYTES {
            log::warn!(
                "SSE line exceeded {} bytes without newline; dropped",
                MAX_LINE_BYTES
            );
            self.buffer.clear();
        }
        out
    }

    /// 上游流错误：发 Anthropic error 事件，finish() 不再补发完成事件。
    pub fn stream_error(&mut self, message: &str) -> Vec<u8> {
        self.saw_stream_error = true;
        self.stream_error_sse(message).into_bytes()
    }

    /// 上游流结束：补发缓存的 message_delta / message_stop；
    /// 若整条流没有任何事件（如上游返回非 SSE 的 JSON body），按整段 completion
    /// JSON 合成一条完整 Anthropic 消息；仍无内容则发 error 事件。
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.saw_stream_error {
            return out;
        }
        if !self.has_sent_message_start && !self.raw_head.is_empty() {
            let raw = String::from_utf8_lossy(&self.raw_head).trim().to_string();
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let has_choice = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if has_choice {
                    self.handle_chunk(&v, &mut out);
                }
            }
        }
        self.close_current_non_tool(&mut out);
        self.close_all_tool_blocks(&mut out);
        self.flush_message_delta(&mut out);
        let emitted = self.ensure_message_delta(&mut out);
        if emitted && !self.has_sent_message_stop {
            out.extend_from_slice(
                sse_bytes("message_stop", json!({"type": "message_stop"})).as_bytes(),
            );
            self.has_sent_message_stop = true;
        }
        if out.is_empty() && !self.has_sent_message_start {
            out.extend_from_slice(
                self.stream_error_sse("upstream returned an empty or non-SSE response")
                    .as_bytes(),
            );
        }
        out
    }

    /// 发出缓存的 message_delta（finish_reason 已到过的情况）。
    fn flush_message_delta(&mut self, out: &mut Vec<u8>) {
        if let Some((stop, usage)) = self.pending_message_delta.take() {
            out.extend_from_slice(self.message_delta_sse(stop, usage).as_bytes());
            self.has_emitted_message_delta = true;
        }
    }

    /// 上游未发 finish_reason 就结束时按 end_turn 补发 message_delta，
    /// 保证 Anthropic 事件序列完整；返回是否发出了 message_delta。
    fn ensure_message_delta(&mut self, out: &mut Vec<u8>) -> bool {
        if self.has_emitted_message_delta {
            return true;
        }
        if !self.has_sent_message_start {
            return false;
        }
        self.has_emitted_message_delta = true;
        let usage = self
            .latest_usage
            .clone()
            .unwrap_or_else(|| json!({"input_tokens": 0, "output_tokens": 0}));
        out.extend_from_slice(
            self.message_delta_sse(Some("end_turn".to_string()), usage)
                .as_bytes(),
        );
        true
    }

    fn process_line(&mut self, line: &str, out: &mut Vec<u8>) {
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(data) = line.strip_prefix("data:") else {
            return;
        };
        if !self.saw_data_line {
            self.saw_data_line = true;
            self.raw_head.clear();
        }
        let data = data.trim();
        if data.is_empty() {
            return;
        }
        if data == "[DONE]" {
            // 先闭合打开的内容块，再发 message_delta / message_stop
            self.close_current_non_tool(out);
            self.close_all_tool_blocks(out);
            self.flush_message_delta(out);
            self.ensure_message_delta(out);
            if !self.has_sent_message_stop {
                out.extend_from_slice(
                    sse_bytes("message_stop", json!({"type": "message_stop"})).as_bytes(),
                );
                self.has_sent_message_stop = true;
            }
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        self.handle_chunk(&v, out);
    }

    fn handle_chunk(&mut self, v: &Value, out: &mut Vec<u8>) {
        if self.message_id.is_empty() {
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                self.message_id = id.to_string();
            }
        }
        if self.current_model.is_empty() {
            if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                self.current_model = m.to_string();
            }
        }

        let chunk_usage = v
            .get("usage")
            .filter(|u| u.is_object())
            .map(build_anthropic_usage_json);
        if let Some(u) = &chunk_usage {
            self.latest_usage = Some(u.clone());
            if let Some((_, pending)) = self.pending_message_delta.as_mut() {
                *pending = u.clone();
            }
        }

        let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
            return; // 纯 usage chunk（choices 为空）已在上方并入 usage
        };

        if !self.has_sent_message_start {
            let start_usage = chunk_usage
                .clone()
                .unwrap_or_else(|| json!({"input_tokens": 0, "output_tokens": 0}));
            let event = json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.current_model,
                    "usage": start_usage,
                }
            });
            out.extend_from_slice(sse_bytes("message_start", event).as_bytes());
            self.has_sent_message_start = true;
        }

        // 流式时是 delta；非流式整段兜底时是 message
        let delta = choice.get("delta").or_else(|| choice.get("message"));

        // reasoning（DeepSeek reasoning_content / OpenRouter reasoning）→ thinking 块
        let reasoning = delta
            .and_then(|d| d.get("reasoning").or_else(|| d.get("reasoning_content")))
            .and_then(|r| r.as_str());
        if let Some(r) = reasoning {
            if !r.is_empty() {
                if self.current_non_tool.as_ref().map(|(t, _)| *t) != Some("thinking") {
                    self.close_current_non_tool(out);
                    let index = self.next_content_index;
                    self.next_content_index += 1;
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_start",
                            json!({
                                "type": "content_block_start", "index": index,
                                "content_block": {"type": "thinking", "thinking": ""}
                            }),
                        )
                        .as_bytes(),
                    );
                    self.current_non_tool = Some(("thinking", index));
                }
                if let Some((_, idx)) = self.current_non_tool {
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta", "index": idx,
                                "delta": {"type": "thinking_delta", "thinking": r}
                            }),
                        )
                        .as_bytes(),
                    );
                }
            }
        }

        // 文本
        let text = delta
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str());
        if let Some(t) = text {
            if !t.is_empty() {
                if self.current_non_tool.as_ref().map(|(t, _)| *t) != Some("text") {
                    self.close_current_non_tool(out);
                    let index = self.next_content_index;
                    self.next_content_index += 1;
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_start",
                            json!({
                                "type": "content_block_start", "index": index,
                                "content_block": {"type": "text", "text": ""}
                            }),
                        )
                        .as_bytes(),
                    );
                    self.current_non_tool = Some(("text", index));
                }
                if let Some((_, idx)) = self.current_non_tool {
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta", "index": idx,
                                "delta": {"type": "text_delta", "text": t}
                            }),
                        )
                        .as_bytes(),
                    );
                }
            }
        }

        // 工具调用
        let tool_calls = delta
            .and_then(|d| d.get("tool_calls"))
            .and_then(|t| t.as_array())
            .filter(|t| !t.is_empty());
        if let Some(tcs) = tool_calls {
            self.close_current_non_tool(out);
            for (pos, tc) in tcs.iter().enumerate() {
                // 非流式整段兜底的 tool_calls 无 index 字段，按数组位置分组
                let up_idx = tc
                    .get("index")
                    .and_then(|i| i.as_u64())
                    .unwrap_or(pos as u64);
                if !self.tool_blocks.contains_key(&up_idx) {
                    let index = self.next_content_index;
                    self.next_content_index += 1;
                    self.tool_blocks.insert(
                        up_idx,
                        ToolBlockState {
                            anthropic_index: index,
                            id: String::new(),
                            name: String::new(),
                            started: false,
                            pending_args: String::new(),
                        },
                    );
                }
                let state = self.tool_blocks.get_mut(&up_idx).unwrap();
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    state.id = id.to_string();
                }
                if let Some(name) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                    state.name = name.to_string();
                }
                let args = tc
                    .pointer("/function/arguments")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let should_start = !state.started && !state.id.is_empty() && !state.name.is_empty();
                let mut pending_after_start: Option<String> = None;
                if should_start {
                    state.started = true;
                    if !state.pending_args.is_empty() {
                        pending_after_start = Some(std::mem::take(&mut state.pending_args));
                    }
                } else if !state.started {
                    // id/name 未到齐：先缓存 arguments，避免 input_json_delta 挂到未知块上
                    state.pending_args.push_str(args);
                    continue;
                }
                let (index, id, name) =
                    (state.anthropic_index, state.id.clone(), state.name.clone());
                if should_start {
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_start",
                            json!({
                                "type": "content_block_start", "index": index,
                                "content_block": {"type": "tool_use", "id": id, "name": name}
                            }),
                        )
                        .as_bytes(),
                    );
                    self.open_tool_blocks.insert(index);
                }
                let args_deltas = [
                    pending_after_start,
                    (!args.is_empty()).then(|| args.to_string()),
                ];
                for a in args_deltas.into_iter().flatten() {
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta", "index": index,
                                "delta": {"type": "input_json_delta", "partial_json": a}
                            }),
                        )
                        .as_bytes(),
                    );
                }
            }
        }

        // finish_reason：只缓存不发，去重；[DONE]/流末尾统一发出 message_delta
        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            let stop_reason = map_stop_reason(fr);
            let usage_json = chunk_usage.or_else(|| self.latest_usage.clone());

            if self.has_emitted_message_delta {
                // 某些上游发送多个带 finish_reason 的 chunk，后续才补全 usage：仅更新缓存
                if let (Some((_, pending)), Some(u)) = (&mut self.pending_message_delta, usage_json)
                {
                    *pending = u;
                }
                return;
            }
            self.has_emitted_message_delta = true;

            self.close_current_non_tool(out);

            // 迟到的工具块：args 先到、id/name 后到（或全程缺失）时兜底开块
            let mut late_starts: Vec<(u32, String, String, String)> = Vec::new();
            for (up_idx, st) in self.tool_blocks.iter_mut() {
                if st.started {
                    continue;
                }
                if st.id.is_empty() && st.name.is_empty() && st.pending_args.is_empty() {
                    continue;
                }
                let id = if st.id.is_empty() {
                    format!("tool_call_{up_idx}")
                } else {
                    st.id.clone()
                };
                let name = if st.name.is_empty() {
                    "unknown_tool".to_string()
                } else {
                    st.name.clone()
                };
                st.started = true;
                late_starts.push((
                    st.anthropic_index,
                    id,
                    name,
                    std::mem::take(&mut st.pending_args),
                ));
            }
            late_starts.sort_unstable_by_key(|(index, _, _, _)| *index);
            for (index, id, name, pending) in late_starts {
                out.extend_from_slice(
                    sse_bytes(
                        "content_block_start",
                        json!({
                            "type": "content_block_start", "index": index,
                            "content_block": {"type": "tool_use", "id": id, "name": name}
                        }),
                    )
                    .as_bytes(),
                );
                self.open_tool_blocks.insert(index);
                if !pending.is_empty() {
                    out.extend_from_slice(
                        sse_bytes(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta", "index": index,
                                "delta": {"type": "input_json_delta", "partial_json": pending}
                            }),
                        )
                        .as_bytes(),
                    );
                }
            }

            self.close_all_tool_blocks(out);

            self.pending_message_delta = Some((
                Some(stop_reason),
                usage_json.unwrap_or_else(|| json!({"input_tokens": 0, "output_tokens": 0})),
            ));
        }
    }

    fn close_current_non_tool(&mut self, out: &mut Vec<u8>) {
        if let Some((_, idx)) = self.current_non_tool.take() {
            out.extend_from_slice(
                sse_bytes(
                    "content_block_stop",
                    json!({"type": "content_block_stop", "index": idx}),
                )
                .as_bytes(),
            );
        }
    }

    fn close_all_tool_blocks(&mut self, out: &mut Vec<u8>) {
        let indices: Vec<u32> = std::mem::take(&mut self.open_tool_blocks)
            .into_iter()
            .collect();
        for idx in indices {
            out.extend_from_slice(
                sse_bytes(
                    "content_block_stop",
                    json!({"type": "content_block_stop", "index": idx}),
                )
                .as_bytes(),
            );
        }
    }

    fn message_delta_sse(&self, stop_reason: Option<String>, usage: Value) -> String {
        sse_bytes(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": Value::Null},
                "usage": usage,
            }),
        )
    }

    fn stream_error_sse(&self, message: &str) -> String {
        sse_bytes(
            "error",
            json!({
                "type": "error",
                "error": {"type": "stream_error", "message": message},
            }),
        )
    }
}

fn sse_bytes(event: &str, data: Value) -> String {
    format!("event: {}\ndata: {}\n\n", event, data)
}

/// OpenAI finish_reason → Anthropic stop_reason。
fn map_stop_reason(finish_reason: &str) -> String {
    match finish_reason {
        "tool_calls" | "function_call" => "tool_use",
        "length" => "max_tokens",
        // stop / content_filter / 其它未知值都归为 end_turn
        _ => "end_turn",
    }
    .to_string()
}

/// OpenAI prompt_tokens 含缓存命中，Anthropic input_tokens 不含，需减去
/// cache_read 与 cache_creation（三桶互斥）。缓存回退链对齐 sse::extract_openai_usage。
fn extract_cache_read(u: &Value) -> u64 {
    u.get("cache_read_input_tokens")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            u.pointer("/prompt_tokens_details/cached_tokens")
                .and_then(|v| v.as_u64())
        })
        .or_else(|| {
            u.pointer("/input_tokens_details/cached_tokens")
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(0)
}

fn extract_cache_write(u: &Value) -> u64 {
    u.get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            u.pointer("/prompt_tokens_details/cache_write_tokens")
                .and_then(|v| v.as_u64())
        })
        .or_else(|| {
            u.pointer("/input_tokens_details/cache_write_tokens")
                .and_then(|v| v.as_u64())
        })
        .unwrap_or(0)
}

fn build_anthropic_usage_json(u: &Value) -> Value {
    let prompt = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let completion = u
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cached = extract_cache_read(u);
    let cache_write = extract_cache_write(u);
    let mut out = json!({
        "input_tokens": prompt.saturating_sub(cached).saturating_sub(cache_write),
        "output_tokens": completion,
    });
    if cached > 0 {
        out["cache_read_input_tokens"] = json!(cached);
    }
    if cache_write > 0 {
        out["cache_creation_input_tokens"] = json!(cache_write);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收集整条流的事件 (event, data) 对。
    fn parse_events(s: &str) -> Vec<(String, Value)> {
        let mut events = Vec::new();
        for block in s.split("\n\n") {
            let block = block.trim();
            if block.is_empty() {
                continue;
            }
            let mut event = String::new();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(e) = line.strip_prefix("event: ") {
                    event = e.to_string();
                } else if let Some(d) = line.strip_prefix("data: ") {
                    data = d.to_string();
                }
            }
            events.push((event, serde_json::from_str(&data).unwrap()));
        }
        events
    }

    fn feed_all(conv: &mut OpenAiSseToAnthropic, chunks: &[&str]) -> String {
        let mut out = String::new();
        for c in chunks {
            out.push_str(&String::from_utf8(conv.push(c.as_bytes())).unwrap());
        }
        out.push_str(&String::from_utf8(conv.finish()).unwrap());
        out
    }

    #[test]
    fn text_stream_converts_to_full_anthropic_sequence() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"id\":\"chatcmpl-1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(events[0].1["message"]["id"], "chatcmpl-1");
        assert_eq!(events[0].1["message"]["model"], "m");
        assert_eq!(events[1].1["content_block"]["type"], "text");
        assert_eq!(events[2].1["delta"]["text"], "he");
        assert_eq!(events[3].1["delta"]["text"], "llo");
        // usage 三桶拆分：input 不含缓存
        assert_eq!(events[5].1["delta"]["stop_reason"], "end_turn");
        assert_eq!(events[5].1["usage"]["input_tokens"], 7);
        assert_eq!(events[5].1["usage"]["output_tokens"], 2);
    }

    #[test]
    fn tool_call_stream_emits_tool_use_blocks() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"{\\\"ci\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ty\\\":\\\"SF\\\"}\"}},{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"ping\",\"arguments\":\"{}\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let starts: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == "content_block_start")
            .map(|(_, d)| d)
            .collect();
        assert_eq!(starts.len(), 2);
        assert_eq!(starts[0]["content_block"]["id"], "call_1");
        assert_eq!(starts[0]["content_block"]["name"], "get_weather");
        assert_eq!(starts[1]["content_block"]["id"], "call_2");
        let deltas: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == "content_block_delta")
            .map(|(_, d)| d)
            .collect();
        // call_1 两段 partial_json + call_1 开块后补发缓存段 + call_2 一段
        let call0: String = deltas
            .iter()
            .filter(|d| d["index"] == 0)
            .map(|d| d["delta"]["partial_json"].as_str().unwrap())
            .collect();
        assert_eq!(call0, "{\"city\":\"SF\"}");
        assert_eq!(events.last().unwrap().0, "message_stop");
        let delta_ev = events.iter().find(|(e, _)| e == "message_delta").unwrap();
        assert_eq!(delta_ev.1["delta"]["stop_reason"], "tool_use");
    }

    #[test]
    fn duplicate_finish_reason_emits_only_one_message_delta() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let deltas: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == "message_delta")
            .map(|(_, d)| d)
            .collect();
        assert_eq!(deltas.len(), 1);
        // usage 取后续补发的完整值
        assert_eq!(deltas[0]["usage"]["input_tokens"], 10);
    }

    #[test]
    fn missing_done_still_completes_message() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n",
            ],
        );
        let events = parse_events(&out);
        assert_eq!(events.last().unwrap().0, "message_stop");
        assert!(events.iter().any(|(e, _)| e == "message_delta"));
    }

    #[test]
    fn missing_finish_reason_still_emits_message_delta() {
        // 上游没发 finish_reason 就 [DONE]：按 end_turn 补发 message_delta，
        // 保证 Anthropic 事件序列完整
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":1}}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        let d = events.iter().find(|(e, _)| e == "message_delta").unwrap();
        assert_eq!(d.1["delta"]["stop_reason"], "end_turn");
        assert_eq!(d.1["usage"]["input_tokens"], 4);
    }

    #[test]
    fn non_sse_json_body_synthesizes_full_message() {
        // forwarder 对非 SSE 的 200 body 走单块兜底：整段 JSON 无 data: 前缀
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                r#"{"id":"chatcmpl-9","model":"m","choices":[{"message":{"content":"你好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#,
            ],
        );
        let events = parse_events(&out);
        let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop"
            ]
        );
        assert_eq!(events[2].1["delta"]["text"], "你好");
        assert_eq!(events[4].1["usage"]["input_tokens"], 10);
    }

    #[test]
    fn empty_stream_emits_error_event() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(&mut conv, &[]);
        let events = parse_events(&out);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "error");
    }

    #[test]
    fn stream_error_suppresses_completion_events() {
        let mut conv = OpenAiSseToAnthropic::new();
        conv.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        let err = String::from_utf8(conv.stream_error("boom")).unwrap();
        let tail = String::from_utf8(conv.finish()).unwrap();
        assert!(err.contains("\"type\": \"error\"") || err.contains("\"type\":\"error\""));
        assert!(tail.is_empty());
    }

    #[test]
    fn usage_only_chunk_updates_latest_usage() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let delta_ev = events.iter().find(|(e, _)| e == "message_delta").unwrap();
        assert_eq!(delta_ev.1["usage"]["input_tokens"], 3);
    }

    #[test]
    fn reasoning_content_maps_to_thinking_block() {
        let mut conv = OpenAiSseToAnthropic::new();
        let out = feed_all(
            &mut conv,
            &[
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"ans\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n",
            ],
        );
        let events = parse_events(&out);
        let starts: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == "content_block_start")
            .map(|(_, d)| d)
            .collect();
        assert_eq!(starts[0]["content_block"]["type"], "thinking");
        assert_eq!(starts[1]["content_block"]["type"], "text");
        // thinking → text 切换时先关闭 thinking 块
        let stops: Vec<&Value> = events
            .iter()
            .filter(|(e, _)| e == "content_block_stop")
            .map(|(_, d)| d)
            .collect();
        assert_eq!(stops.len(), 2);
        assert_eq!(stops[0]["index"], 0);
    }
}
