// Skills 管理命令：CRUD + 目录同步（~/.claude/skills/<directory>/SKILL.md）
//
// 启用 = 写目标文件（写前 timestamped 备份，失败回滚 DB enabled），
// 禁用 = 删除目标文件（容忍 NotFound），删除 = 先删文件再删记录。

use crate::db::models::{McpServer, Skill};
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

/// synced = 目标文件内容与 DB content 一致（忽略首尾空白）。
fn is_skill_synced(home: &Path, skill: &Skill) -> bool {
    match std::fs::read_to_string(skill_path(home, &skill.directory)) {
        Ok(content) => content.trim() == skill.content.trim(),
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

/// 磁盘上实际安装的 skill（~/.claude/skills/<dir>/SKILL.md），含 frontmatter 信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub directory: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub mcp_servers: Vec<McpDecl>,
    pub in_db: bool,
    pub enabled: bool,
    pub synced: bool,
}

/// SKILL.md frontmatter 里声明的 MCP server。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDecl {
    pub name: String,
    pub config: serde_json::Value,
}

/// 解析 SKILL.md 的 YAML frontmatter（首对 `---` 之间），转成 JSON 对象。
fn parse_frontmatter(content: &str) -> Option<serde_json::Value> {
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.iter().position(|l| l.trim() == "---")? + 1;
    let end = lines[start..]
        .iter()
        .position(|l| l.trim() == "---")
        .map(|i| start + i)
        .unwrap_or(lines.len());
    let text = lines[start..end].join("\n");
    let doc = yaml_rust2::YamlLoader::load_from_str(&text).ok()?.into_iter().next()?;
    Some(yaml_to_json(&doc))
}

fn yaml_to_json(y: &yaml_rust2::Yaml) -> serde_json::Value {
    use yaml_rust2::Yaml;
    match y {
        Yaml::Real(s) => serde_json::Value::String(s.clone()),
        Yaml::Integer(i) => serde_json::Value::Number((*i).into()),
        Yaml::String(s) => serde_json::Value::String(s.clone()),
        Yaml::Boolean(b) => serde_json::Value::Bool(*b),
        Yaml::Array(a) => serde_json::Value::Array(a.iter().map(yaml_to_json).collect()),
        Yaml::Hash(h) => {
            let mut m = serde_json::Map::new();
            for (k, v) in h {
                if let Some(key) = k.as_str() {
                    m.insert(key.to_string(), yaml_to_json(v));
                }
            }
            serde_json::Value::Object(m)
        }
        _ => serde_json::Value::Null,
    }
}

/// 从 frontmatter 提取 `mcp.servers`（name → config 对象）。
fn extract_mcp_servers(fm: &serde_json::Value) -> Vec<McpDecl> {
    let mut out = Vec::new();
    let Some(servers) = fm
        .get("mcp")
        .and_then(|m| m.get("servers"))
        .and_then(|s| s.as_object())
    else {
        return out;
    };
    for (name, config) in servers {
        if !name.is_empty() {
            out.push(McpDecl {
                name: name.clone(),
                config: config.clone(),
            });
        }
    }
    out
}

/// 列出磁盘上实际安装的 skills（含不在 DB 管理列表中的）。
#[tauri::command]
pub fn list_installed_skills(state: State<AppState>) -> Result<Vec<InstalledSkill>, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    list_installed_skills_with_home(&state, &home)
}

pub(crate) fn list_installed_skills_with_home(
    state: &AppState,
    home: &Path,
) -> Result<Vec<InstalledSkill>, String> {
    let db_skills = state.repo.list_skills().map_err(|e| e.to_string())?;
    let by_dir: std::collections::HashMap<&str, &Skill> =
        db_skills.iter().map(|s| (s.directory.as_str(), s)).collect();

    let root = skills_root(home);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(directory) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let directory = directory.to_string();
        let path = dir.join("SKILL.md");
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let fm = parse_frontmatter(&content);
        let name = fm
            .as_ref()
            .and_then(|v| v.get("name").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        let description = fm
            .as_ref()
            .and_then(|v| v.get("description").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        let version = fm
            .as_ref()
            .and_then(|v| v.get("version").and_then(|x| x.as_str()))
            .map(|s| s.to_string());
        let mcp_servers = fm.as_ref().map(extract_mcp_servers).unwrap_or_default();
        let db_skill = by_dir.get(directory.as_str()).copied();
        let synced = db_skill.map(|s| content.trim() == s.content.trim()).unwrap_or(false);
        out.push(InstalledSkill {
            directory,
            name,
            description,
            version,
            mcp_servers,
            in_db: db_skill.is_some(),
            enabled: db_skill.map(|s| s.enabled).unwrap_or(false),
            synced,
        });
    }
    out.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(out)
}

/// 把磁盘上已安装的 skill 导入到 DB 管理列表（已存在则按磁盘内容更新）。
#[tauri::command]
pub fn import_installed_skill(
    state: State<AppState>,
    directory: String,
) -> Result<Skill, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    import_installed_skill_with_home(&state, &home, &directory)
}

pub(crate) fn import_installed_skill_with_home(
    state: &AppState,
    home: &Path,
    directory: &str,
) -> Result<Skill, String> {
    if !is_valid_directory(directory) {
        return Err("目录名仅允许字母、数字、_ 和 -".into());
    }
    let path = skill_path(home, directory);
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {}: {}", path.display(), e))?;
    let fm = parse_frontmatter(&content);
    let name = fm
        .as_ref()
        .and_then(|v| v.get("name").and_then(|x| x.as_str()))
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| directory.to_string());
    let description = fm
        .as_ref()
        .and_then(|v| v.get("description").and_then(|x| x.as_str()))
        .map(|s| s.to_string());
    let existing = state
        .repo
        .get_skill_by_directory(directory)
        .map_err(|e| e.to_string())?;
    let skill = Skill {
        id: existing.map(|s| s.id).unwrap_or_default(),
        name,
        description,
        directory: directory.to_string(),
        content,
        enabled: false,
        created_at: 0,
        updated_at: 0,
    };
    upsert_skill_with_home(state, home, skill)
}

/// 把 SKILL.md frontmatter 声明的 MCP server 同步到 MCP 服务器管理列表。
/// 同名已存在则更新其配置与描述，否则新建。返回同步数量。
#[tauri::command]
pub fn sync_skill_mcp(state: State<AppState>, directory: String) -> Result<usize, String> {
    let home = dirs::home_dir().ok_or("无法确定用户主目录")?;
    sync_skill_mcp_with_home(&state, &home, &directory)
}

pub(crate) fn sync_skill_mcp_with_home(
    state: &AppState,
    home: &Path,
    directory: &str,
) -> Result<usize, String> {
    if !is_valid_directory(directory) {
        return Err("目录名仅允许字母、数字、_ 和 -".into());
    }
    let path = skill_path(home, directory);
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 {}: {}", path.display(), e))?;
    let fm = parse_frontmatter(&content).ok_or_else(|| "SKILL.md 缺少 frontmatter".to_string())?;
    let decls = extract_mcp_servers(&fm);
    if decls.is_empty() {
        return Ok(0);
    }
    let now = chrono::Utc::now().timestamp();
    let mut count = 0;
    for decl in decls {
        let server = match state
            .repo
            .get_mcp_server_by_name(&decl.name)
            .map_err(|e| e.to_string())?
        {
            Some(existing) => McpServer {
                server_config: decl.config.clone(),
                updated_at: now,
                ..existing
            },
            None => McpServer {
                id: uuid::Uuid::new_v4().to_string(),
                name: decl.name.clone(),
                server_config: decl.config,
                description: None,
                enabled: true,
                created_at: now,
                updated_at: now,
            },
        };
        state
            .repo
            .upsert_mcp_server(&server)
            .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
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

    const FM_SKILL: &str = "---\nname: my-skill\ndescription: Does things\nversion: 1.2.0\nmcp:\n  servers:\n    fs-server:\n      command: npx\n      args: ['-y', '@modelcontextprotocol/server-filesystem']\n      env:\n        KEY: val\n---\n# Body\n";

    #[test]
    fn parse_frontmatter_extracts_meta_and_mcp() {
        let fm = parse_frontmatter(FM_SKILL).unwrap();
        assert_eq!(fm.get("name").and_then(|v| v.as_str()), Some("my-skill"));
        assert_eq!(
            fm.get("description").and_then(|v| v.as_str()),
            Some("Does things")
        );
        assert_eq!(fm.get("version").and_then(|v| v.as_str()), Some("1.2.0"));

        let decls = extract_mcp_servers(&fm);
        assert_eq!(decls.len(), 1);
        assert_eq!(decls[0].name, "fs-server");
        assert_eq!(
            decls[0].config.get("command").and_then(|v| v.as_str()),
            Some("npx")
        );
        assert_eq!(
            decls[0].config.get("env").and_then(|v| v.get("KEY")).and_then(|v| v.as_str()),
            Some("val")
        );
        // 无 frontmatter → None
        assert!(parse_frontmatter("# no frontmatter").is_none());
    }

    #[test]
    fn list_installed_skills_marks_in_db_and_mcp() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        std::fs::create_dir_all(skills_root(home).join("my-skill")).unwrap();
        std::fs::write(skill_path(home, "my-skill"), FM_SKILL).unwrap();
        std::fs::create_dir_all(skills_root(home).join("plain")).unwrap();
        std::fs::write(skill_path(home, "plain"), "# plain skill").unwrap();

        // 未导入：in_db=false
        let listed = list_installed_skills_with_home(&state, home).unwrap();
        assert_eq!(listed.len(), 2);
        let my = listed.iter().find(|s| s.directory == "my-skill").unwrap();
        assert!(!my.in_db);
        assert_eq!(my.name.as_deref(), Some("my-skill"));
        assert_eq!(my.mcp_servers.len(), 1);
        assert_eq!(listed.iter().find(|s| s.directory == "plain").unwrap().mcp_servers.len(), 0);

        // 导入后 in_db=true 且 synced
        import_installed_skill_with_home(&state, home, "my-skill").unwrap();
        let listed2 = list_installed_skills_with_home(&state, home).unwrap();
        let my2 = listed2.iter().find(|s| s.directory == "my-skill").unwrap();
        assert!(my2.in_db);
        assert!(my2.synced);
    }

    #[test]
    fn sync_skill_mcp_creates_and_updates_servers() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();

        std::fs::create_dir_all(skills_root(home).join("my-skill")).unwrap();
        std::fs::write(skill_path(home, "my-skill"), FM_SKILL).unwrap();

        let n = sync_skill_mcp_with_home(&state, home, "my-skill").unwrap();
        assert_eq!(n, 1);
        let servers = state.repo.list_mcp_servers().unwrap();
        assert_eq!(servers.len(), 1);
        let id = servers[0].id.clone();
        assert_eq!(servers[0].name, "fs-server");
        assert_eq!(
            servers[0].server_config.get("command").and_then(|v| v.as_str()),
            Some("npx")
        );

        // 再次同步（配置变了）→ 更新同名，不新增
        std::fs::write(
            skill_path(home, "my-skill"),
            FM_SKILL.replace("npx", "pnpm"),
        )
        .unwrap();
        let n2 = sync_skill_mcp_with_home(&state, home, "my-skill").unwrap();
        assert_eq!(n2, 1);
        let servers2 = state.repo.list_mcp_servers().unwrap();
        assert_eq!(servers2.len(), 1);
        assert_eq!(servers2[0].id, id);
        assert_eq!(
            servers2[0].server_config.get("command").and_then(|v| v.as_str()),
            Some("pnpm")
        );
    }
}
