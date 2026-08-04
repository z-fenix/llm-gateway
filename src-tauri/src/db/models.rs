use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub created_at: i64,
}
