use crate::db::models::Channel;
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

fn mask(key: &str) -> String {
    if key.len() <= 4 {
        return "****".into();
    }
    format!("sk-***{}", &key[key.len() - 4..])
}

#[derive(Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub error: Option<String>,
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Result<Vec<Channel>, String> {
    let mut cs = state.repo.list_channels().map_err(|e| e.to_string())?;
    for c in &mut cs {
        c.api_key = mask(&c.api_key);
    }
    Ok(cs)
}

#[tauri::command]
pub fn create_channel(state: State<AppState>, mut c: Channel) -> Result<Channel, String> {
    c.id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    c.created_at = now;
    c.updated_at = now;
    state.repo.insert_channel(&c).map_err(|e| e.to_string())?;
    let mut out = c.clone();
    out.api_key = mask(&out.api_key);
    Ok(out)
}

#[tauri::command]
pub fn update_channel(state: State<AppState>, mut c: Channel) -> Result<(), String> {
    c.updated_at = chrono::Utc::now().timestamp();
    // api_key 若是打码形式则不更新（保留原值）
    if c.api_key.starts_with("sk-***") {
        if let Some(orig) = state.repo.get_channel(&c.id).map_err(|e| e.to_string())? {
            c.api_key = orig.api_key;
        }
    }
    state.repo.update_channel(&c).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_channel(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_channel(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_channel(state: State<'_, AppState>, id: String) -> Result<TestResult, String> {
    let ch = state
        .repo
        .get_channel(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "channel not found".to_string())?;
    let url = crate::provider::adapter::upstream_url(&ch.provider_type, &ch.base_url, false);
    let (hname, hval) = crate::provider::adapter::auth_header(&ch.provider_type, &ch.api_key);
    let start = std::time::Instant::now();
    let body = serde_json::json!({
        "model": ch.models.get(0).cloned().unwrap_or("test".into()),
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1
    });
    let resp = state
        .http
        .post(&url)
        .header(hname, hval)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64))
        .json(&body)
        .send()
        .await;
    let latency = start.elapsed().as_millis() as i64;
    match resp {
        Ok(r) if r.status().is_success() => Ok(TestResult {
            ok: true,
            latency_ms: latency,
            error: None,
        }),
        Ok(r) => Ok(TestResult {
            ok: false,
            latency_ms: latency,
            error: Some(format!("status {}", r.status())),
        }),
        Err(e) => Ok(TestResult {
            ok: false,
            latency_ms: latency,
            error: Some(e.to_string()),
        }),
    }
}
