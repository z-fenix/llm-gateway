use crate::db::models::ApiKey;
use crate::proxy::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_api_keys(state: State<AppState>) -> Result<Vec<ApiKey>, String> {
    state.repo.list_api_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_api_key(
    state: State<AppState>,
    name: String,
    quota_total: Option<i64>,
) -> Result<ApiKey, String> {
    let k = ApiKey {
        id: uuid::Uuid::new_v4().to_string(),
        key: crate::auth::generate_key(),
        name,
        enabled: true,
        quota_total,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: chrono::Utc::now().timestamp(),
        last_used_at: None,
    };
    state.repo.insert_api_key(&k).map_err(|e| e.to_string())?;
    Ok(k)
}

#[tauri::command]
pub fn set_api_key_enabled(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .repo
        .set_api_key_enabled(&id, enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_api_key(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_quota(
    state: State<AppState>,
    id: String,
    quota_total: Option<i64>,
) -> Result<(), String> {
    state
        .repo
        .update_quota(&id, quota_total)
        .map_err(|e| e.to_string())
}

fn update_api_key_with_state(
    state: &AppState,
    id: String,
    name: String,
    quota_total: Option<i64>,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if let Some(q) = quota_total {
        if q < 0 {
            return Err("配额不能为负数".into());
        }
    }
    let existing = state
        .repo
        .list_api_keys()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|k| k.id == id)
        .ok_or("API key 不存在")?;
    let key = ApiKey {
        id,
        name: name.to_string(),
        quota_total,
        ..existing
    };
    state.repo.update_api_key(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_api_key(
    state: State<AppState>,
    id: String,
    name: String,
    quota_total: Option<i64>,
) -> Result<(), String> {
    update_api_key_with_state(&state, id, name, quota_total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::ApiKey;
    use crate::db::Db;

    fn sample_key(id: &str) -> ApiKey {
        ApiKey {
            id: id.into(),
            key: format!("sk-lgw-{id}"),
            name: "alice".into(),
            enabled: true,
            quota_total: Some(1000),
            quota_used: 5,
            total_calls: 1,
            total_tokens: 10,
            created_at: 1,
            last_used_at: Some(2),
        }
    }

    #[test]
    fn update_api_key_renames_and_sets_quota() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_api_key(&sample_key("k1")).unwrap();

        update_api_key_with_state(&state, "k1".into(), "Alice Renamed".into(), Some(5000)).unwrap();

        let got = state
            .repo
            .list_api_keys()
            .unwrap()
            .into_iter()
            .find(|k| k.id == "k1")
            .unwrap();
        assert_eq!(got.name, "Alice Renamed");
        assert_eq!(got.quota_total, Some(5000));
        assert_eq!(got.quota_used, 5);
        assert_eq!(got.key, "sk-lgw-k1");
        assert!(got.enabled);
        assert_eq!(got.last_used_at, Some(2));
    }

    #[test]
    fn update_api_key_clears_quota() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_api_key(&sample_key("k1")).unwrap();

        update_api_key_with_state(&state, "k1".into(), "alice".into(), None).unwrap();

        let got = state
            .repo
            .list_api_keys()
            .unwrap()
            .into_iter()
            .find(|k| k.id == "k1")
            .unwrap();
        assert_eq!(got.quota_total, None);
    }

    #[test]
    fn update_api_key_rejects_empty_name() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_api_key(&sample_key("k1")).unwrap();

        let err =
            update_api_key_with_state(&state, "k1".into(), "   ".into(), Some(100)).unwrap_err();
        assert_eq!(err, "名称不能为空");
    }

    #[test]
    fn update_api_key_rejects_negative_quota() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_api_key(&sample_key("k1")).unwrap();

        let err =
            update_api_key_with_state(&state, "k1".into(), "alice".into(), Some(-1)).unwrap_err();
        assert_eq!(err, "配额不能为负数");
    }

    #[test]
    fn update_api_key_missing_key() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        let err = update_api_key_with_state(&state, "missing".into(), "alice".into(), Some(100))
            .unwrap_err();
        assert_eq!(err, "API key 不存在");
    }

    #[test]
    fn update_api_key_trims_name() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_api_key(&sample_key("k1")).unwrap();

        update_api_key_with_state(&state, "k1".into(), "  alice  ".into(), Some(100)).unwrap();

        let got = state
            .repo
            .list_api_keys()
            .unwrap()
            .into_iter()
            .find(|k| k.id == "k1")
            .unwrap();
        assert_eq!(got.name, "alice");
    }
}
