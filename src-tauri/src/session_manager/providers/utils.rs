use std::fs::File;
use std::io::{self, BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use chrono::{DateTime, FixedOffset};
use serde_json::Value;

/// 会话标题最大字符数（各 provider 共用）。
pub const TITLE_MAX_CHARS: usize = 80;

/// 读取文件前 `head_n` 行与末尾 `tail_n` 行。小文件(<16KB)一次读完切分。
pub fn read_head_tail_lines(
    path: &Path,
    head_n: usize,
    tail_n: usize,
) -> io::Result<(Vec<String>, Vec<String>)> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();

    if file_len < 16_384 {
        let reader = BufReader::new(file);
        let all: Vec<String> = reader.lines().map_while(Result::ok).collect();
        let head = all.iter().take(head_n).cloned().collect();
        let skip = all.len().saturating_sub(tail_n);
        let tail = all.into_iter().skip(skip).collect();
        return Ok((head, tail));
    }

    let reader = BufReader::new(file);
    let head: Vec<String> = reader.lines().take(head_n).map_while(Result::ok).collect();

    let seek_pos = file_len.saturating_sub(16_384);
    let mut file2 = File::open(path)?;
    file2.seek(SeekFrom::Start(seek_pos))?;
    let tail_reader = BufReader::new(file2);
    let all_tail: Vec<String> = tail_reader.lines().map_while(Result::ok).collect();

    let skip_first = if seek_pos > 0 { 1 } else { 0 };
    let usable: Vec<String> = all_tail.into_iter().skip(skip_first).collect();
    let skip = usable.len().saturating_sub(tail_n);
    let tail = usable.into_iter().skip(skip).collect();

    Ok((head, tail))
}

pub fn parse_timestamp_to_ms(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    if let Some(n) = value.as_f64() {
        let n = n as i64;
        return Some(if n > 1_000_000_000_000 { n } else { n * 1000 });
    }
    let raw = value.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt: DateTime<FixedOffset>| dt.timestamp_millis())
}

pub fn extract_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(extract_text_from_item)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn extract_text_from_item(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");

    if matches!(item_type, "tool_use" | "toolCall") {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Some(format!("[Tool: {name}]"));
    }

    if item_type == "tool_result" {
        if let Some(content) = item.get("content") {
            let text = extract_text(content);
            if !text.is_empty() {
                return Some(text);
            }
        }
        return None;
    }

    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("input_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(text) = item.get("output_text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }

    if let Some(content) = item.get("content") {
        let text = extract_text(content);
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

/// 结构化阅读块；兼容 Claude 内容块、Codex response_item 与 Gemini 工具记录。
pub fn extract_blocks(content: &Value) -> Vec<crate::session_manager::SessionBlock> {
    use crate::session_manager::SessionBlock as B;
    let string = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    match content {
        Value::String(text) if !text.trim().is_empty() => vec![B::Text { text: text.clone() }],
        Value::Array(items) => items.iter().flat_map(extract_blocks).collect(),
        Value::Object(_) => {
            let kind = content["type"].as_str().unwrap_or("");
            match kind {
                "thinking" | "reasoning" => {
                    let text = string(content.get("thinking"))
                        .or_else(|| string(content.get("text")))
                        .unwrap_or_else(|| extract_text(&content["summary"]));
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![B::Thinking { text }]
                    }
                }
                "tool_use" | "toolCall" | "function_call" | "custom_tool_call" => {
                    let raw = content
                        .get("input")
                        .or_else(|| content.get("args"))
                        .or_else(|| content.get("arguments"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let input = raw
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(raw);
                    vec![B::ToolCall {
                        id: string(content.get("call_id").or_else(|| content.get("id"))),
                        name: string(content.get("name")),
                        input,
                    }]
                }
                "tool_result" | "function_call_output" | "custom_tool_call_output" => {
                    let raw = content
                        .get("content")
                        .or_else(|| content.get("output"))
                        .unwrap_or(&Value::Null);
                    let text = extract_text(raw);
                    let output = if text.is_empty() && !raw.is_null() {
                        raw.to_string()
                    } else {
                        text
                    };
                    vec![B::ToolResult {
                        id: string(
                            content
                                .get("tool_use_id")
                                .or_else(|| content.get("call_id"))
                                .or_else(|| content.get("id")),
                        ),
                        output,
                        status: if content["is_error"].as_bool() == Some(true) {
                            "error"
                        } else {
                            "unknown"
                        }
                        .into(),
                    }]
                }
                _ => {
                    let text = extract_text(&Value::Array(vec![content.clone()]));
                    if text.is_empty() {
                        vec![]
                    } else {
                        vec![B::Text { text }]
                    }
                }
            }
        }
        _ => vec![],
    }
}

pub fn truncate_summary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let mut result = trimmed.chars().take(max_chars).collect::<String>();
    result.push_str("...");
    result
}

pub fn path_basename(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.trim_end_matches(['/', '\\']);
    let last = normalized
        .split(['/', '\\'])
        .next_back()
        .filter(|segment| !segment.is_empty())?;
    Some(last.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_timestamp_to_ms_supports_integers_and_rfc3339() {
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_033_i64)),
            Some(1_771_061_953_033)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!(1_771_061_953_i64)),
            Some(1_771_061_953_000)
        );
        assert_eq!(
            parse_timestamp_to_ms(&json!("1970-01-01T00:00:01Z")),
            Some(1_000)
        );
    }

    #[test]
    fn extract_text_supports_tool_calls() {
        assert_eq!(
            extract_text(&json!([{ "type": "toolCall", "name": "read" }])),
            "[Tool: read]"
        );
    }
}
