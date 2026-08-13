use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub priority: i64,
    pub weight: i64,
    pub enabled: bool,
    pub timeout_secs: i64,
    pub total_calls: i64,
    pub total_tokens: i64,
    pub success_rate: f64,
    pub avg_latency_ms: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub key: String,
    pub name: String,
    pub enabled: bool,
    pub quota_total: Option<i64>,
    pub quota_used: i64,
    pub total_calls: i64,
    pub total_tokens: i64,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRoute {
    pub id: String,
    pub role: String,
    pub channel_id: String,
    pub target_model: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolePattern {
    pub id: String,
    pub pattern: String,
    pub role: String,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLog {
    pub id: String,
    pub seq: i64,
    pub trace_id: String,
    pub api_key_id: Option<String>,
    pub key_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub role: Option<String>,
    pub request_model: Option<String>,
    pub upstream_model: Option<String>,
    pub protocol: String,
    pub status_code: Option<i64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub latency_ms: i64,
    pub is_stream: bool,
    pub error: Option<String>,
    pub fallback: bool,
    pub tool_calls: Option<String>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub risk_level: String,
    pub risk_score: i64,
    pub risk_summary: Option<String>,
    pub security_action: String,
    pub sanitized: bool,
    pub blocked_reason: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestSecurityFinding {
    pub id: String, pub log_id: String, pub phase: String, pub category: String,
    pub rule_id: String, pub severity: String, pub title: String,
    pub description: Option<String>, pub location: Option<String>,
    pub evidence_masked: Option<String>, pub evidence_hash: Option<String>,
    pub action: Option<String>, pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinRule {
    pub id: String, pub rule_id: String, pub category: String, pub severity: String,
    pub title: String, pub description: Option<String>, pub toggle_key: Option<String>,
    pub enabled: bool, pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomRule {
    pub id: String, pub rule_type: String, pub category: String, pub pattern: String,
    pub severity: String, pub action: String, pub enabled: bool,
    pub description: Option<String>, pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub embedding_channel_id: Option<String>,
    pub embedding_model: String,
    pub dim: i64,
    pub doc_count: i64,
    pub chunk_count: i64,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 派生字段（不落库）：库有分块但 usearch 索引文件缺失时置 true，UI 提示一键重建。
    #[serde(default)]
    pub needs_reindex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbDocument {
    pub id: String,
    pub kb_id: String,
    pub filename: String,
    pub file_type: String,
    pub size_bytes: i64,
    pub chunk_count: i64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbChunk {
    pub id: String,
    pub doc_id: String,
    pub kb_id: String,
    pub seq: i64,
    pub symbol: Option<String>,
    pub content: String,
    pub token_count: i64,
    pub embedding_id: i64,
}
