use crate::db::models::Prompt;
use crate::proxy::state::AppState;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub fn list_prompts(state: State<AppState>) -> Result<Vec<Prompt>, String> {
    state.repo.list_prompts().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_enabled_prompt(state: State<AppState>) -> Result<Option<Prompt>, String> {
    let prompts = state.repo.list_prompts().map_err(|e| e.to_string())?;
    Ok(prompts.into_iter().find(|p| p.enabled))
}

fn upsert_prompt_with_state(
    state: &AppState,
    id: Option<String>,
    name: String,
    content: String,
    description: Option<String>,
) -> Result<Prompt, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    upsert_prompt_with_home(state, &home, id, name, content, description)
}

pub(crate) fn upsert_prompt_with_home(
    state: &AppState,
    home: &Path,
    id: Option<String>,
    name: String,
    content: String,
    description: Option<String>,
) -> Result<Prompt, String> {
    let name = name.trim();
    let content = content.trim();
    if name.is_empty() || content.is_empty() {
        return Err("名称和内容不能为空".into());
    }

    let id = id.filter(|s| !s.is_empty());
    let now = chrono::Utc::now().timestamp();
    let (id, created_at, enabled) = match &id {
        Some(existing_id) => {
            if let Ok(Some(existing)) = state.repo.get_prompt(existing_id) {
                (existing_id.clone(), existing.created_at, existing.enabled)
            } else {
                (existing_id.clone(), now, false)
            }
        }
        None => (uuid::Uuid::new_v4().to_string(), now, false),
    };

    let prompt = Prompt {
        id,
        name: name.to_string(),
        content: content.to_string(),
        description,
        enabled,
        created_at,
        updated_at: now,
    };

    state
        .repo
        .upsert_prompt(&prompt)
        .map_err(|e| e.to_string())?;

    // 启用中 Prompt 编辑后同步重写 ~/.claude/CLAUDE.md（保留备份）；失败仅报错，
    // DB 保留用户编辑，错误信息会回到 UI。
    if prompt.enabled {
        let path = settings_path(home);
        if let Err(e) = crate::cli_config::backup_and_write_ts(&path, &prompt.content) {
            return Err(format!("已保存，但写入 {} 失败: {}", path.display(), e));
        }
    }
    Ok(prompt)
}

#[tauri::command]
pub fn upsert_prompt(
    state: State<AppState>,
    id: Option<String>,
    name: String,
    content: String,
    description: Option<String>,
) -> Result<Prompt, String> {
    upsert_prompt_with_state(&state, id, name, content, description)
}

#[tauri::command]
pub fn delete_prompt(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(prompt) = state.repo.get_prompt(&id).map_err(|e| e.to_string())? {
        if prompt.enabled {
            return Err("启用中的 Prompt 不能删除".into());
        }
    }
    state.repo.delete_prompt(&id).map_err(|e| e.to_string())
}

fn claude_dir(home: &Path) -> PathBuf {
    home.join(".claude")
}

fn settings_path(home: &Path) -> PathBuf {
    claude_dir(home).join("CLAUDE.md")
}

pub(crate) fn enable_prompt_with_home(
    state: &AppState,
    home: &Path,
    id: &str,
) -> Result<(), String> {
    let prompt = state
        .repo
        .get_prompt(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Prompt 不存在".to_string())?;
    state
        .repo
        .set_prompt_enabled(id, true)
        .map_err(|e| e.to_string())?;
    let path = settings_path(home);
    match crate::cli_config::backup_and_write_ts(&path, &prompt.content) {
        Ok(_) => Ok(()),
        Err(e) => {
            state.repo.set_prompt_enabled(id, false).ok();
            Err(e)
        }
    }
}

#[tauri::command]
pub fn enable_prompt(state: State<AppState>, id: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    enable_prompt_with_home(&state, &home, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn upsert_creates_and_validates() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        let err = upsert_prompt_with_state(&state, None, "   ".into(), "content".into(), None)
            .unwrap_err();
        assert_eq!(err, "名称和内容不能为空");

        let err =
            upsert_prompt_with_state(&state, None, "name".into(), "   ".into(), None).unwrap_err();
        assert_eq!(err, "名称和内容不能为空");

        let prompt = upsert_prompt_with_state(
            &state,
            None,
            "  code-review  ".into(),
            "  Review the code.  ".into(),
            Some("desc".into()),
        )
        .unwrap();
        assert_eq!(prompt.name, "code-review");
        assert_eq!(prompt.content, "Review the code.");
        assert_eq!(prompt.description, Some("desc".into()));
        assert!(!prompt.enabled);
        assert!(!prompt.id.is_empty());

        let listed = state.repo.list_prompts().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "code-review");
    }

    #[test]
    fn upsert_preserves_enabled_state() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let a = upsert_prompt_with_home(
            &state,
            home,
            Some("p-a".into()),
            "Prompt A".into(),
            "content A".into(),
            None,
        )
        .unwrap();
        assert!(!a.enabled);

        enable_prompt_with_home(&state, home, &a.id).unwrap();
        assert!(state.repo.get_prompt(&a.id).unwrap().unwrap().enabled);

        let updated = upsert_prompt_with_home(
            &state,
            home,
            Some("p-a".into()),
            "Prompt A Updated".into(),
            "content A updated".into(),
            Some("updated desc".into()),
        )
        .unwrap();
        assert!(updated.enabled);
        assert_eq!(updated.name, "Prompt A Updated");
        assert_eq!(updated.content, "content A updated");

        let stored = state.repo.get_prompt(&a.id).unwrap().unwrap();
        assert!(stored.enabled);
        assert_eq!(stored.content, "content A updated");
    }

    #[test]
    fn upsert_enabled_prompt_rewrites_claude_md() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let a = upsert_prompt_with_home(
            &state,
            home,
            Some("p-a".into()),
            "Prompt A".into(),
            "v1".into(),
            None,
        )
        .unwrap();
        enable_prompt_with_home(&state, home, &a.id).unwrap();
        assert_eq!(std::fs::read_to_string(settings_path(home)).unwrap(), "v1");

        // 编辑启用中的 Prompt → upsert 后 CLAUDE.md 应同步为新内容（保留备份）
        let updated = upsert_prompt_with_home(
            &state,
            home,
            Some(a.id.clone()),
            "Prompt A Updated".into(),
            "v2".into(),
            None,
        )
        .unwrap();
        assert!(updated.enabled);
        assert_eq!(updated.content, "v2");
        assert_eq!(std::fs::read_to_string(settings_path(home)).unwrap(), "v2");

        let bak_exists = std::fs::read_dir(claude_dir(home))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| s.starts_with("CLAUDE.md.bak-"))
                    .unwrap_or(false)
            });
        assert!(bak_exists, "expected a CLAUDE.md.bak-* backup");
    }

    #[test]
    fn upsert_enabled_prompt_write_failure_reports_but_keeps_db() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let a = upsert_prompt_with_home(
            &state,
            home,
            Some("p-a".into()),
            "Prompt A".into(),
            "v1".into(),
            None,
        )
        .unwrap();
        enable_prompt_with_home(&state, home, &a.id).unwrap();

        // 让 CLAUDE.md 位置变成目录 → 备份/写盘必然失败
        std::fs::remove_file(settings_path(home)).unwrap();
        std::fs::create_dir_all(settings_path(home)).unwrap();

        let err = upsert_prompt_with_home(
            &state,
            home,
            Some(a.id.clone()),
            "Prompt A Updated".into(),
            "v2".into(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("已保存"), "err: {err}");
        assert!(err.contains("CLAUDE.md"), "err: {err}");

        // DB 保留用户编辑，enabled 不变
        let stored = state.repo.get_prompt(&a.id).unwrap().unwrap();
        assert_eq!(stored.content, "v2");
        assert!(stored.enabled);
    }

    #[test]
    fn enable_writes_file_and_exclusive() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let a = upsert_prompt_with_state(
            &state,
            Some("p-a".into()),
            "Prompt A".into(),
            "content A".into(),
            None,
        )
        .unwrap();
        let b = upsert_prompt_with_state(
            &state,
            Some("p-b".into()),
            "Prompt B".into(),
            "content B".into(),
            None,
        )
        .unwrap();

        enable_prompt_with_home(&state, home, &a.id).unwrap();
        assert_eq!(
            std::fs::read_to_string(settings_path(home)).unwrap(),
            "content A"
        );
        assert!(state.repo.get_prompt(&a.id).unwrap().unwrap().enabled);
        assert!(!state.repo.get_prompt(&b.id).unwrap().unwrap().enabled);

        enable_prompt_with_home(&state, home, &b.id).unwrap();
        assert_eq!(
            std::fs::read_to_string(settings_path(home)).unwrap(),
            "content B"
        );
        assert!(!state.repo.get_prompt(&a.id).unwrap().unwrap().enabled);
        assert!(state.repo.get_prompt(&b.id).unwrap().unwrap().enabled);
    }

    #[test]
    fn delete_enabled_rejected() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let a = upsert_prompt_with_state(
            &state,
            Some("p-a".into()),
            "Prompt A".into(),
            "content A".into(),
            None,
        )
        .unwrap();
        enable_prompt_with_home(&state, home, &a.id).unwrap();

        let err = delete_prompt_with_state(&state, a.id.clone()).unwrap_err();
        assert_eq!(err, "启用中的 Prompt 不能删除");

        assert!(state.repo.get_prompt(&a.id).unwrap().is_some());
    }

    fn delete_prompt_with_state(state: &AppState, id: String) -> Result<(), String> {
        if let Some(prompt) = state.repo.get_prompt(&id).map_err(|e| e.to_string())? {
            if prompt.enabled {
                return Err("启用中的 Prompt 不能删除".into());
            }
        }
        state.repo.delete_prompt(&id).map_err(|e| e.to_string())
    }

    #[test]
    fn enable_backup_created() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        std::fs::create_dir_all(claude_dir(home)).unwrap();
        std::fs::write(settings_path(home), "old content").unwrap();

        let a = upsert_prompt_with_state(
            &state,
            Some("p-a".into()),
            "Prompt A".into(),
            "new content".into(),
            None,
        )
        .unwrap();
        enable_prompt_with_home(&state, home, &a.id).unwrap();

        let bak_exists = std::fs::read_dir(claude_dir(home))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| s.starts_with("CLAUDE.md.bak-"))
                    .unwrap_or(false)
            });
        assert!(bak_exists, "expected a CLAUDE.md.bak-* file");
        assert_eq!(
            std::fs::read_to_string(settings_path(home)).unwrap(),
            "new content"
        );
    }
}
