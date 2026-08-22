use crate::db::models::{Channel, ModelMapEntry};
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
    let model = ch.models.get(0).cloned().unwrap_or("test".into());
    let url = crate::provider::adapter::upstream_url(&ch.upstream_protocol, &ch.base_url, &model, &ch.api_key, false);
    let mut req = state
        .http
        .post(&url)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
    if let Some((hname, hval)) = crate::provider::adapter::auth_header(&ch.upstream_protocol, &ch.api_key) {
        req = req.header(hname, hval);
    }
    let chat = crate::protocol::types::ChatRequest {
        model: model.clone(),
        messages: vec![crate::protocol::types::ChatMessage {
            role: "user".into(),
            content: serde_json::json!("ping"),
        }],
        max_tokens: Some(1),
        stream: false,
        temperature: None,
        tools: None,
        extra: Default::default(),
    };
    let body = crate::provider::adapter::build_upstream_body(&chat, &ch.upstream_protocol, &model);
    let start = std::time::Instant::now();
    let resp = req.json(&body).send().await;
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

#[tauri::command]
pub fn set_model_map(
    state: State<AppState>,
    channel_id: String,
    source_model: String,
    target_model: String,
) -> Result<(), String> {
    set_model_map_with_state(&state,
        channel_id,
        source_model,
        target_model,
    )
}

fn set_model_map_with_state(
    state: &AppState,
    channel_id: String,
    source_model: String,
    target_model: String,
) -> Result<(), String> {
    if source_model.trim().is_empty() || target_model.trim().is_empty() {
        return Err("源模型与目标模型不能为空".into());
    }
    state
        .repo
        .set_model_map(&channel_id, &source_model, &target_model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_model_map(
    state: State<AppState>,
    channel_id: String,
    source_model: String,
) -> Result<(), String> {
    delete_model_map_with_state(&state, channel_id, source_model)
}

fn delete_model_map_with_state(
    state: &AppState,
    channel_id: String,
    source_model: String,
) -> Result<(), String> {
    state
        .repo
        .delete_model_map(&channel_id, &source_model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_model_map(
    state: State<AppState>,
    channel_id: String,
) -> Result<Vec<ModelMapEntry>, String> {
    get_model_map_with_state(&state, channel_id)
}

fn get_model_map_with_state(
    state: &AppState,
    channel_id: String,
) -> Result<Vec<ModelMapEntry>, String> {
    state
        .repo
        .get_model_map(&channel_id)
        .map_err(|e| e.to_string())
        .map(|pairs| {
            pairs
                .into_iter()
                .map(|(source_model, target_model)| ModelMapEntry {
                    channel_id: channel_id.clone(),
                    source_model,
                    target_model,
                })
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn test_channel(id: &str) -> Channel {
        Channel {
            id: id.into(),
            name: "test".into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
            base_url: "https://api.openai.com".into(),
            api_key: "sk-test".into(),
            models: vec!["gpt-4o".into()],
            priority: 0,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn model_map_set_get_delete_roundtrip() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        set_model_map_with_state(&state, "ch1".into(), "gpt-4o".into(), "gpt-4o-2024-08-06".into())
            .unwrap();
        set_model_map_with_state(&state, "ch1".into(), "claude-sonnet".into(), "claude-3-5-sonnet".into())
            .unwrap();

        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 2);
        let mut by_source: std::collections::HashMap<&str, &str> = maps
            .iter()
            .map(|m| (m.source_model.as_str(), m.target_model.as_str()))
            .collect();
        assert_eq!(by_source.remove("gpt-4o"), Some("gpt-4o-2024-08-06"));
        assert_eq!(by_source.remove("claude-sonnet"), Some("claude-3-5-sonnet"));
        assert!(by_source.is_empty());
        assert!(maps.iter().all(|m| m.channel_id == "ch1"));

        delete_model_map_with_state(&state, "ch1".into(), "gpt-4o".into()).unwrap();
        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].source_model, "claude-sonnet");
    }

    #[test]
    fn model_map_overwrite_updates_target() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        set_model_map_with_state(&state, "ch1".into(), "gpt-4o".into(), "gpt-4o-2024-05".into())
            .unwrap();
        set_model_map_with_state(
            &state,
            "ch1".into(),
            "gpt-4o".into(),
            "gpt-4o-2024-08-06".into(),
        )
        .unwrap();

        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].target_model, "gpt-4o-2024-08-06");
    }

    #[test]
    fn model_map_empty_model_rejected() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        let err = set_model_map_with_state(&state, "ch1".into(), "".into(), "gpt-4o".into())
            .unwrap_err();
        assert_eq!(err, "源模型与目标模型不能为空");

        let err = set_model_map_with_state(
            &state,
            "ch1".into(),
            "gpt-4o".into(),
            "   ".into(),
        )
        .unwrap_err();
        assert_eq!(err, "源模型与目标模型不能为空");
    }
}
