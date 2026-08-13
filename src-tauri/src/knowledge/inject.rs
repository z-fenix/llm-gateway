use crate::knowledge::retrieve::RetrievedChunk;
use crate::protocol::types::{ChatMessage, ChatRequest};
use serde_json::Value;

/// 估算字符串的 token 数:字符数 / 4(向上取整,避免短文本被估算为 0)。
fn estimate_tokens(s: &str) -> i64 {
    (s.chars().count() as i64 + 3) / 4
}

/// 格式化单个片段:`--- 片段N (来自 {filename}{ · symbol}) ---\n{content}`。
fn format_chunk(n: usize, chunk: &RetrievedChunk) -> String {
    let source = match chunk.symbol.as_deref() {
        Some(sym) if !sym.trim().is_empty() => format!("{} · {}", chunk.filename, sym),
        _ => chunk.filename.clone(),
    };
    format!("--- 片段{n} (来自 {source}) ---\n{}", chunk.content)
}

/// 纯函数:把检索片段拼成注入用的知识库参考块。
///
/// 按 score 降序拼接,外包 `[知识库参考资料]` 头与「请基于以上资料回答,不相关则忽略。」尾;
/// 头尾文案也计入 token,总估算 token 超过 `max_tokens` 时丢弃尾部片段;空输入返回 None。
pub fn build_context_block(chunks: &[RetrievedChunk], max_tokens: i64) -> Option<String> {
    if chunks.is_empty() {
        return None;
    }

    let mut sorted: Vec<&RetrievedChunk> = chunks.iter().collect();
    sorted.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let header = "[知识库参考资料]";
    let footer = "请基于以上资料回答,不相关则忽略。";
    // 尾部文案连同其前导换行一起预留,保证截断时头尾都能放下
    let footer_reserve = estimate_tokens("\n\n") + estimate_tokens(footer);

    if estimate_tokens(header) > max_tokens {
        return None;
    }

    let mut out = String::new();
    let mut tokens = 0i64;
    let mut included = 0usize;

    out.push_str(header);
    tokens += estimate_tokens(header);

    for (idx, chunk) in sorted.iter().enumerate() {
        let addition = format!("\n\n{}", format_chunk(idx + 1, chunk));
        let add_tokens = estimate_tokens(&addition);
        if tokens + add_tokens + footer_reserve > max_tokens {
            break;
        }
        out.push_str(&addition);
        tokens += add_tokens;
        included += 1;
    }

    if included == 0 {
        return None;
    }

    out.push_str("\n\n");
    out.push_str(footer);
    Some(out)
}

/// 提取消息 `content` 中的纯文本;非字符串/非数组形态返回 None(保守)。
fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Value::Array(arr) => {
            let mut parts: Vec<String> = Vec::new();
            for item in arr {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

/// 纯函数:取最后一条 role=="user" 消息的文本作为检索 query。
pub fn extract_query(chat: &ChatRequest) -> Option<String> {
    let user_msg = chat.messages.iter().rev().find(|m| m.role == "user")?;
    content_text(&user_msg.content)
}

/// 双协议 context 注入:
/// - 无 system 消息 → 在最前插入 system 消息(content 为字符串);
/// - 已有 system 且 content 为字符串 → 改为 `context + "\n\n" + 原文`;
/// - 已有 system 且 content 为数组 → 在最前 prepend 一个 `{"type":"text","text":context}` 块;
/// - 其他形态 → 保守处理,不强行注入,保留原样。
pub fn inject_context(chat: &mut ChatRequest, context: &str) {
    if let Some(pos) = chat.messages.iter().position(|m| m.role == "system") {
        match &mut chat.messages[pos].content {
            Value::String(s) => {
                let original = std::mem::take(s);
                *s = format!("{}\n\n{}", context, original);
            }
            Value::Array(arr) => {
                arr.insert(0, serde_json::json!({"type": "text", "text": context}));
            }
            _ => {}
        }
    } else {
        chat.messages.insert(
            0,
            ChatMessage {
                role: "system".to_string(),
                content: Value::String(context.to_string()),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(
        embedding_id: i64,
        filename: &str,
        symbol: Option<&str>,
        content: &str,
        score: f64,
    ) -> RetrievedChunk {
        RetrievedChunk {
            embedding_id,
            content: content.to_string(),
            symbol: symbol.map(str::to_string),
            filename: filename.to_string(),
            score,
        }
    }

    fn chat_with(messages: Vec<ChatMessage>) -> ChatRequest {
        ChatRequest {
            model: "test-model".to_string(),
            messages,
            max_tokens: None,
            stream: false,
            temperature: None,
            tools: None,
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn build_context_block_formats_and_truncates() {
        let chunks = vec![
            chunk(1, "a.txt", None, "AAAA", 0.9),
            chunk(2, "b.txt", Some("func"), "BBBB", 0.8),
            chunk(3, "c.txt", None, "CCCC", 0.7),
        ];

        // max_tokens 很小,只装得下头部 + 第一个片段
        let block = build_context_block(&chunks, 18).unwrap();

        assert!(block.contains("[知识库参考资料]"), "{block}");
        assert!(block.contains("--- 片段1 (来自 a.txt) ---"), "{block}");
        assert!(block.contains("AAAA"), "{block}");
        assert!(block.contains("请基于以上资料回答,不相关则忽略。"), "{block}");
        assert!(!block.contains("BBBB"), "{block}");
        assert!(!block.contains("CCCC"), "{block}");
    }

    #[test]
    fn build_context_block_empty_none() {
        assert!(build_context_block(&[], 100).is_none());
    }

    #[test]
    fn extract_query_last_user_message() {
        // 多条消息,取最后一条 user,字符串 content 直接用
        let chat = chat_with(vec![
            ChatMessage {
                role: "user".to_string(),
                content: Value::String("first".to_string()),
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: Value::String("hi".to_string()),
            },
            ChatMessage {
                role: "user".to_string(),
                content: Value::String("second".to_string()),
            },
        ]);
        assert_eq!(extract_query(&chat).as_deref(), Some("second"));

        // 块数组形态:只拼 type=="text" 的 text 块
        let chat = chat_with(vec![ChatMessage {
            role: "user".to_string(),
            content: json!([
                {"type": "text", "text": "hello"},
                {"type": "text", "text": "world"},
                {"type": "image_url", "text": "IGNORE"}
            ]),
        }]);
        assert_eq!(extract_query(&chat).as_deref(), Some("hello\nworld"));
    }

    #[test]
    fn extract_query_none_when_no_user_or_empty() {
        // 无 user 消息
        let chat = chat_with(vec![ChatMessage {
            role: "assistant".to_string(),
            content: Value::String("hi".to_string()),
        }]);
        assert!(extract_query(&chat).is_none());

        // user content 为空字符串
        let chat = chat_with(vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String(String::new()),
        }]);
        assert!(extract_query(&chat).is_none());

        // user content 为数组但无 text 块
        let chat = chat_with(vec![ChatMessage {
            role: "user".to_string(),
            content: json!([{"type": "image_url", "image_url": {"url": "x"}}]),
        }]);
        assert!(extract_query(&chat).is_none());
    }

    #[test]
    fn inject_context_inserts_system_when_absent() {
        let mut chat = chat_with(vec![ChatMessage {
            role: "user".to_string(),
            content: Value::String("hi".to_string()),
        }]);

        inject_context(&mut chat, "CTX");

        assert_eq!(chat.messages.len(), 2);
        assert_eq!(chat.messages[0].role, "system");
        assert!(chat.messages[0].content.as_str().unwrap().contains("CTX"));
    }

    #[test]
    fn inject_context_prepends_existing_system_string() {
        let mut chat = chat_with(vec![
            ChatMessage {
                role: "system".to_string(),
                content: Value::String("ORIG".to_string()),
            },
            ChatMessage {
                role: "user".to_string(),
                content: Value::String("hi".to_string()),
            },
        ]);

        inject_context(&mut chat, "CTX");

        let s = chat.messages[0].content.as_str().unwrap();
        assert!(s.starts_with("CTX\n\n"), "{s}");
        assert!(s.ends_with("ORIG"), "{s}");
    }

    #[test]
    fn inject_context_prepends_block_array() {
        let mut chat = chat_with(vec![
            ChatMessage {
                role: "system".to_string(),
                content: json!([{"type": "text", "text": "ORIG"}]),
            },
            ChatMessage {
                role: "user".to_string(),
                content: Value::String("hi".to_string()),
            },
        ]);

        inject_context(&mut chat, "CTX");

        let arr = chat.messages[0].content.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "CTX");
        assert_eq!(arr[1]["text"], "ORIG");
    }
}
