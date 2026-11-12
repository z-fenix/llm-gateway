use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

/// 从原始请求体中提取会话 ID。优先级：
/// 1. Claude Code 顶层 `metadata.user_id`（形如
///    `user_<hash>_account_<uuid>_session_<uuid>`，尾段 UUID 与
///    `~/.claude/projects/<项目>/<sessionId>.jsonl` 文件名一致）；
/// 2. 消息级 `sessionId` 字段（扫描 messages / input 数组）。
pub fn extract_session_id(body: &serde_json::Value) -> Option<String> {
    if let Some(sid) = body
        .get("metadata")
        .and_then(|m| m.get("user_id"))
        .and_then(|v| v.as_str())
        .and_then(|uid| uid.rsplit_once("_session_"))
        .map(|(_, sid)| sid.trim())
        .filter(|sid| !sid.is_empty())
    {
        return Some(sid.to_string());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_session_id_parses_metadata_user_id_session_segment() {
        let body = serde_json::json!({
            "model": "claude-sonnet-4",
            "metadata": {"user_id": "user_abc123def_account_11111111-2222-3333-4444-555555555555_session_99999999-aaaa-bbbb-cccc-dddddddddddd"}
        });
        assert_eq!(
            extract_session_id(&body).as_deref(),
            Some("99999999-aaaa-bbbb-cccc-dddddddddddd")
        );
    }

    #[test]
    fn extract_session_id_ignores_user_id_without_session_segment() {
        let body = serde_json::json!({"metadata": {"user_id": "user_abc123"}});
        assert_eq!(extract_session_id(&body), None);
        let empty = serde_json::json!({});
        assert_eq!(extract_session_id(&empty), None);
    }
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
