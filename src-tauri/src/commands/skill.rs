// Skills 管理命令：CRUD + 目录同步（~/.claude/skills/<directory>/SKILL.md）
//
// 启用 = 写目标文件（写前 timestamped 备份，失败回滚 DB enabled），
// 禁用 = 删除目标文件（容忍 NotFound），删除 = 先删文件再删记录。

use crate::db::models::Skill;
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillView {
    pub skill: Skill,
    pub synced: bool,
}

fn skills_root(home: &Path) -> PathBuf {
    home.join(".claude").join("skills")
}

fn skill_path(home: &Path, directory: &str) -> PathBuf {
    skills_root(home).join(directory).join("SKILL.md")
}

/// 目录白名单校验：非空且每个字符满足 [A-Za-z0-9_-]，防路径穿越。
fn is_valid_directory(directory: &str) -> bool {
    !directory.is_empty()
        && directory
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// synced = 目标文件存在且内容与 DB content 完全一致（spec §3.4）。
fn is_skill_synced(home: &Path, skill: &Skill) -> bool {
    match std::fs::read_to_string(skill_path(home, &skill.directory)) {
        Ok(content) => content == skill.content,
        Err(_) => false,
    }
}

#[tauri::command]
pub fn list_skills(state: State<AppState>) -> Result<Vec<SkillView>, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    list_skills_with_home(&state, &home)
}

pub(crate) fn list_skills_with_home(
    state: &AppState,
    home: &Path,
) -> Result<Vec<SkillView>, String> {
    state
        .repo
        .list_skills()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|skill| {
            Ok(SkillView {
                synced: is_skill_synced(home, &skill),
                skill,
            })
        })
        .collect()
}

#[tauri::command]
pub fn upsert_skill(state: State<AppState>, skill: Skill) -> Result<Skill, String> {
    upsert_skill_with_state(&state, skill)
}

pub(crate) fn upsert_skill_with_state(state: &AppState, skill: Skill) -> Result<Skill, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    upsert_skill_with_home(state, &home, skill)
}

pub(crate) fn upsert_skill_with_home(
    state: &AppState,
    home: &Path,
    skill: Skill,
) -> Result<Skill, String> {
    let name = skill.name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    let content = skill.content.trim();
    if content.is_empty() {
        return Err("内容不能为空".into());
    }
    let directory = skill.directory.trim();
    if !is_valid_directory(directory) {
        return Err("目录名仅允许字母、数字、_ 和 -".into());
    }

    let now = chrono::Utc::now().timestamp();
    // 已存在的 Skill：保留现有 enabled/created_at，不信任前端传入的开关/时间戳字段。
    let (id, created_at, enabled) = if skill.id.is_empty() {
        (uuid::Uuid::new_v4().to_string(), now, false)
    } else {
        match state.repo.get_skill(&skill.id).map_err(|e| e.to_string())? {
            Some(existing) => (skill.id.clone(), existing.created_at, existing.enabled),
            None => (skill.id.clone(), now, false),
        }
    };

    // 目录唯一性：另一 id 的 Skill 已占用同一 directory → 拒绝（防互相覆盖 SKILL.md）。
    if let Some(other) = state
        .repo
        .get_skill_by_directory(directory)
        .map_err(|e| e.to_string())?
    {
        if other.id != id {
            return Err("该目录已被其他 Skill 使用".into());
        }
    }

    let saved = Skill {
        id,
        name: name.to_string(),
        description: skill.description,
        directory: directory.to_string(),
        content: content.to_string(),
        enabled,
        created_at,
        updated_at: now,
    };

    state.repo.upsert_skill(&saved).map_err(|e| e.to_string())?;

    // 启用中 Skill 编辑后同步重写 SKILL.md（保留备份）；失败仅报错，DB 保留用户编辑，
    // 前端 `synced` 徽标会据此显示 未同步。
    if saved.enabled {
        let path = skill_path(home, &saved.directory);
        if let Err(e) = crate::cli_config::backup_and_write_ts(&path, &saved.content) {
            return Err(format!("已保存，但写入 {} 失败: {}", path.display(), e));
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn delete_skill(state: State<AppState>, id: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    delete_skill_with_home(&state, &home, &id)
}

pub(crate) fn delete_skill_with_home(
    state: &AppState,
    home: &Path,
    id: &str,
) -> Result<(), String> {
    let skill = state
        .repo
        .get_skill(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Skill 不存在".to_string())?;
    if !is_valid_directory(&skill.directory) {
        return Err("目录名仅允许字母、数字、_ 和 -".into());
    }
    // 先删目标目录文件，再删记录（spec §3.4）
    let path = skill_path(home, &skill.directory);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除 {}: {}", path.display(), e)),
    }
    state.repo.delete_skill(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_skill_enabled(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    toggle_skill_enabled_with_home(&state, &home, &id, enabled)
}

pub(crate) fn toggle_skill_enabled_with_home(
    state: &AppState,
    home: &Path,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    let skill = state
        .repo
        .get_skill(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Skill 不存在".to_string())?;
    if !is_valid_directory(&skill.directory) {
        return Err("目录名仅允许字母、数字、_ 和 -".into());
    }
    state
        .repo
        .set_skill_enabled(id, enabled)
        .map_err(|e| e.to_string())?;
    let path = skill_path(home, &skill.directory);
    let res = if enabled {
        crate::cli_config::backup_and_write_ts(&path, &skill.content)
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("删除 {}: {}", path.display(), e)),
        }
    };
    if let Err(e) = res {
        state.repo.set_skill_enabled(id, !enabled).ok();
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Skill;
    use crate::db::Db;

    fn make_skill(id: &str, directory: &str, content: &str) -> Skill {
        Skill {
            id: id.into(),
            name: if id.is_empty() {
                "skill".into()
            } else {
                id.into()
            },
            description: None,
            directory: directory.into(),
            content: content.into(),
            enabled: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn skill_with_name(id: &str, name: &str, directory: &str, content: &str) -> Skill {
        Skill {
            id: id.into(),
            name: name.into(),
            description: None,
            directory: directory.into(),
            content: content.into(),
            enabled: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn upsert_rejects_bad_directory() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        // 路径穿越 / 分隔符 / 非法字符 / 空目录 全部拒绝
        for dir in ["../evil", "a/b", "", "a b", "a..b", "a.b", "my dir"] {
            let skill = make_skill("s", dir, "content");
            let err = upsert_skill_with_state(&state, skill).unwrap_err();
            assert!(err.contains("目录名"), "dir={dir:?} err={err}");
        }

        // name / content 非空校验
        let err = upsert_skill_with_state(&state, make_skill("s", "ok-dir", "  ")).unwrap_err();
        assert_eq!(err, "内容不能为空");

        let err = upsert_skill_with_state(&state, skill_with_name("s", "  ", "ok-dir", "content"))
            .unwrap_err();
        assert_eq!(err, "名称不能为空");
    }

    #[test]
    fn upsert_rejects_duplicate_directory() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        // 先建一个占用 "dup-dir" 的 skill
        upsert_skill_with_state(&state, make_skill("a", "dup-dir", "content A")).unwrap();

        // 另一 id 的 skill 使用相同目录 → 拒绝
        let err =
            upsert_skill_with_state(&state, make_skill("b", "dup-dir", "content B")).unwrap_err();
        assert_eq!(err, "该目录已被其他 Skill 使用");

        // 同一 id 重复 upsert 相同目录 → 允许（更新自身）
        upsert_skill_with_state(&state, make_skill("a", "dup-dir", "content A updated")).unwrap();

        // 拒绝后 DB 仍只有一条记录
        assert_eq!(state.repo.list_skills().unwrap().len(), 1);
        assert_eq!(
            state.repo.get_skill("a").unwrap().unwrap().content,
            "content A updated"
        );
    }

    #[test]
    fn toggle_enabled_writes_and_syncs() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(
            &state,
            make_skill("", "myskill", "# My Skill\n\nUseful content"),
        )
        .unwrap();
        assert!(!state.repo.get_skill(&skill.id).unwrap().unwrap().enabled);

        // 启用 → 写盘 + DB enabled
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert!(state.repo.get_skill(&skill.id).unwrap().unwrap().enabled);
        assert_eq!(
            std::fs::read_to_string(skill_path(home, "myskill")).unwrap(),
            "# My Skill\n\nUseful content"
        );

        // 文件存在且内容匹配 → synced
        let listed = list_skills_with_home(&state, home).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].synced);

        // 禁用 → 文件删除 + DB enabled=false → synced=false
        toggle_skill_enabled_with_home(&state, home, &skill.id, false).unwrap();
        assert!(!state.repo.get_skill(&skill.id).unwrap().unwrap().enabled);
        assert!(!skill_path(home, "myskill").exists());

        let listed = list_skills_with_home(&state, home).unwrap();
        assert!(!listed[0].synced);
    }

    #[test]
    fn toggle_disabled_removes_file() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "rm-dir", "content")).unwrap();
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert!(skill_path(home, "rm-dir").exists());

        toggle_skill_enabled_with_home(&state, home, &skill.id, false).unwrap();
        assert!(!skill_path(home, "rm-dir").exists());

        // 再次禁用：文件已不存在也应成功（容忍 NotFound）
        toggle_skill_enabled_with_home(&state, home, &skill.id, false).unwrap();
    }

    #[test]
    fn upsert_enabled_skill_rewrites_skilmd() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "sync-dir", "v1")).unwrap();
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(skill_path(home, "sync-dir")).unwrap(),
            "v1"
        );

        // 编辑启用中的 Skill → upsert 后 SKILL.md 应同步为新内容（保留备份）
        let mut updated = make_skill(&skill.id, "sync-dir", "v2");
        updated.enabled = true;
        let saved = upsert_skill_with_home(&state, home, updated).unwrap();
        assert_eq!(saved.content, "v2");
        assert!(saved.enabled);
        assert_eq!(
            std::fs::read_to_string(skill_path(home, "sync-dir")).unwrap(),
            "v2"
        );
        // 写盘成功 → synced
        let listed = list_skills_with_home(&state, home).unwrap();
        assert!(listed[0].synced);

        // 备份存在（v1 被保留为 .bak-*）
        let bak_exists = std::fs::read_dir(skills_root(home).join("sync-dir"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| s.starts_with("SKILL.md.bak-"))
                    .unwrap_or(false)
            });
        assert!(bak_exists, "expected a SKILL.md.bak-* backup");
    }

    #[test]
    fn upsert_enabled_skill_write_failure_reports_but_keeps_db() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "f-dir", "v1")).unwrap();
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(skill_path(home, "f-dir")).unwrap(),
            "v1"
        );

        // 让目标 SKILL.md 位置变成目录 → 写盘必然失败
        std::fs::remove_file(skill_path(home, "f-dir")).unwrap();
        std::fs::create_dir_all(skill_path(home, "f-dir")).unwrap();

        let mut updated = make_skill(&skill.id, "f-dir", "v2");
        updated.enabled = true;
        let err = upsert_skill_with_home(&state, home, updated).unwrap_err();
        assert!(err.contains("已保存"), "err: {err}");
        assert!(err.contains("SKILL.md"), "err: {err}");

        // DB 保留用户编辑，enabled 不变
        let stored = state.repo.get_skill(&skill.id).unwrap().unwrap();
        assert_eq!(stored.content, "v2");
        assert!(stored.enabled);
    }

    #[test]
    fn upsert_skill_preserves_enabled_state() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "keep-dir", "v1")).unwrap();
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert!(state.repo.get_skill(&skill.id).unwrap().unwrap().enabled);

        // 前端回传 enabled=false（表单未携带开关）→ 不得把启用项悄悄关掉
        let incoming = make_skill(&skill.id, "keep-dir", "v2"); // enabled=false
        let saved = upsert_skill_with_home(&state, home, incoming).unwrap();
        assert!(saved.enabled, "existing enabled must be preserved");
        assert_eq!(saved.content, "v2");
        // 文件同步为新内容
        assert_eq!(
            std::fs::read_to_string(skill_path(home, "keep-dir")).unwrap(),
            "v2"
        );
    }

    #[test]
    fn list_marks_synced() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        // a: 文件存在且内容匹配 → synced=true
        upsert_skill_with_state(&state, make_skill("a", "synced-dir", "match")).unwrap();
        // b: 文件存在但内容不同 → synced=false
        upsert_skill_with_state(&state, make_skill("b", "dirty-dir", "db content")).unwrap();
        // c: 文件不存在 → synced=false
        upsert_skill_with_state(&state, make_skill("c", "absent-dir", "no file")).unwrap();

        std::fs::create_dir_all(skills_root(home).join("synced-dir")).unwrap();
        std::fs::write(skill_path(home, "synced-dir"), "match").unwrap();
        std::fs::create_dir_all(skills_root(home).join("dirty-dir")).unwrap();
        std::fs::write(skill_path(home, "dirty-dir"), "different on disk").unwrap();

        let listed = list_skills_with_home(&state, home).unwrap();
        assert_eq!(listed.len(), 3);
        let by_id = |id: &str| listed.iter().find(|v| v.skill.id == id).unwrap();
        assert!(by_id("a").synced, "matching file should be synced");
        assert!(!by_id("b").synced, "differing file should NOT be synced");
        assert!(!by_id("c").synced, "absent file should NOT be synced");
    }

    #[test]
    fn toggle_write_failure_rolls_back_db() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "rb-dir", "content")).unwrap();
        // 目标 SKILL.md 位置已存在为目录 → 备份 copy 必然失败 → 写盘失败
        std::fs::create_dir_all(skill_path(home, "rb-dir")).unwrap();

        let err = toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap_err();
        assert!(!err.is_empty(), "expected a write failure");
        // 写盘失败后 DB enabled 应回滚为 false
        assert!(!state.repo.get_skill(&skill.id).unwrap().unwrap().enabled);
    }

    #[test]
    fn delete_removes_file_then_record() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        let skill = upsert_skill_with_state(&state, make_skill("", "del-dir", "content")).unwrap();
        toggle_skill_enabled_with_home(&state, home, &skill.id, true).unwrap();
        assert!(skill_path(home, "del-dir").exists());

        delete_skill_with_home(&state, home, &skill.id).unwrap();
        assert!(!skill_path(home, "del-dir").exists());
        assert!(state.repo.get_skill(&skill.id).unwrap().is_none());
    }
}
