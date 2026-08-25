use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

/// 从原始请求体中提取第一个消息级 sessionId（扫描 messages / input 数组）。
/// 用于 Claude Code 等客户端在消息对象里携带 `sessionId` 的场景。
pub fn extract_session_id(body: &serde_json::Value) -> Option<String> {
    let arrays = [
        body.get("messages").and_then(|m| m.as_array()),
        body.get("input").and_then(|i| i.as_array()),
    ];
    for arr in arrays.into_iter().flatten() {
        for item in arr {
            if let Some(sid) = item.get("sessionId").and_then(|v| v.as_str()) {
                if !sid.is_empty() {
                    return Some(sid.to_string());
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
    #[serde(default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    pub model: String,
    pub content: serde_json::Value,
    pub stop_reason: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// 缓存命中 token（仅内部记账用，不回写客户端 usage）
    #[serde(default)]
    pub cache_read_tokens: u64,
    /// 缓存写入 token（仅内部记账用，不回写客户端 usage）
    #[serde(default)]
    pub cache_creation_tokens: u64,
    pub raw: serde_json::Value,
}
