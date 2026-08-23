use super::{backup_and_write, CliWriteResult};
use std::path::{Path, PathBuf};

pub fn settings_path(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}
pub fn dotclaude_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}

fn load_root(existing: Option<&str>) -> Result<serde_json::Value, String> {
    match existing {
        Some(s) if !s.trim().is_empty() => {
            let v: serde_json::Value =
                serde_json::from_str(s).map_err(|e| format!("parse json: {e}"))?;
            Ok(if v.is_object() {
                v
            } else {
                serde_json::json!({})
            })
        }
        _ => Ok(serde_json::json!({})),
    }
}

/// 深合并 settings.json 的 env 块,保留无关键。返回 (pretty_json, changed_keys)。
pub fn merge_settings(
    existing: Option<&str>,
    base_url: &str,
    token: &str,
) -> Result<(String, Vec<String>), String> {
    let mut root = load_root(existing)?;
    let root_obj = root.as_object_mut().unwrap();
    let env = root_obj
        .entry("env")
        .or_insert_with(|| serde_json::json!({}));
    if !env.is_object() {
        *env = serde_json::json!({});
    }
    let env = env.as_object_mut().unwrap();
    let mut changed = vec![];
    for (k, val) in [
        ("ANTHROPIC_BASE_URL", base_url),
        ("ANTHROPIC_AUTH_TOKEN", token),
    ] {
        if env.get(k).and_then(|v| v.as_str()) != Some(val) {
            env.insert(k.to_string(), serde_json::Value::String(val.to_string()));
            changed.push(format!("env.{k}"));
        }
    }
    Ok((
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
        changed,
    ))
}

/// 确保 .claude.json hasCompletedOnboarding=true(否则 CC 强制登录页忽略 env)。
pub fn merge_dotclaude(existing: Option<&str>) -> Result<(String, Vec<String>), String> {
    let mut root = load_root(existing)?;
    let obj = root.as_object_mut().unwrap();
    let mut changed = vec![];
    if obj.get("hasCompletedOnboarding").and_then(|v| v.as_bool()) != Some(true) {
        obj.insert(
            "hasCompletedOnboarding".to_string(),
            serde_json::Value::Bool(true),
        );
        changed.push("hasCompletedOnboarding".to_string());
    }
    Ok((
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?,
        changed,
    ))
}

/// 读取可选的配置文件。
///
/// - `Ok(None)`：文件不存在，调用方应按空对象处理。
/// - `Ok(Some(content))`：读取成功。
/// - `Err(...)`：文件存在但读取失败（权限、IO 等），必须向上传播，避免在
///   未合并旧设置的情况下静默覆盖。
fn read_opt(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

/// 写 settings.json + .claude.json,各返回一个 CliWriteResult。
pub fn write(home: &Path, base_url: &str, token: &str) -> Result<Vec<CliWriteResult>, String> {
    let sp = settings_path(home);
    let (content, changed) = merge_settings(read_opt(&sp)?.as_deref(), base_url, token)?;
    let backup = backup_and_write(&sp, &content)?;
    let mut out = vec![CliWriteResult {
        path: sp.display().to_string(),
        changed_keys: changed,
        backup_path: backup,
        env_instructions: None,
    }];
    let dp = dotclaude_path(home);
    let (dcontent, dchanged) = merge_dotclaude(read_opt(&dp)?.as_deref())?;
    let dbackup = backup_and_write(&dp, &dcontent)?;
    out.push(CliWriteResult {
        path: dp.display().to_string(),
        changed_keys: dchanged,
        backup_path: dbackup,
        env_instructions: None,
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_config::backup_and_write_ts;

    #[test]
    fn merge_settings_preserves_unrelated_and_sets_env() {
        let existing = r#"{ "model": "opus", "env": { "OTHER": "1" } }"#;
        let (out, changed) =
            merge_settings(Some(existing), "http://127.0.0.1:8779", "sk-lgw-abc").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], serde_json::json!("opus")); // 无关键保留
        assert_eq!(v["env"]["OTHER"], serde_json::json!("1")); // env 无关键保留
        assert_eq!(
            v["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("http://127.0.0.1:8779")
        );
        assert_eq!(
            v["env"]["ANTHROPIC_AUTH_TOKEN"],
            serde_json::json!("sk-lgw-abc")
        );
        assert!(changed.contains(&"env.ANTHROPIC_BASE_URL".to_string()));
    }

    #[test]
    fn merge_settings_handles_missing_or_empty() {
        let (out, _) = merge_settings(None, "http://x", "tok").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], serde_json::json!("tok"));
    }

    #[test]
    fn merge_dotclaude_sets_onboarding_keeps_rest() {
        let (out, changed) = merge_dotclaude(Some(r#"{"userID":"u1"}"#)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hasCompletedOnboarding"], serde_json::json!(true));
        assert_eq!(v["userID"], serde_json::json!("u1"));
        assert!(changed.contains(&"hasCompletedOnboarding".to_string()));
    }

    #[test]
    fn read_opt_missing_returns_none() {
        let home = tempfile::tempdir().unwrap();
        let p = settings_path(home.path());
        assert_eq!(read_opt(&p).unwrap(), None);
    }

    #[test]
    fn read_opt_readable_returns_content() {
        let home = tempfile::tempdir().unwrap();
        let p = settings_path(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"model":"opus"}"#).unwrap();
        assert_eq!(
            read_opt(&p).unwrap().as_deref(),
            Some(r#"{"model":"opus"}"#)
        );
    }

    #[test]
    fn read_opt_unreadable_returns_err() {
        // 用目录占据文件路径来可移植地模拟读错误。
        let home = tempfile::tempdir().unwrap();
        let p = settings_path(home.path());
        std::fs::create_dir_all(&p).unwrap();
        let err = read_opt(&p).unwrap_err();
        assert!(err.contains("read"));
        assert!(err.contains(p.display().to_string().as_str()));
    }

    #[test]
    fn write_creates_files_and_backup() {
        let home = tempfile::tempdir().unwrap();
        // 先写一次（无备份），再写一次（有备份）。
        let r1 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-a").unwrap();
        assert!(settings_path(home.path()).exists());
        assert!(dotclaude_path(home.path()).exists());
        assert_eq!(r1.len(), 2);
        assert!(r1[0].backup_path.is_none());

        let r2 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-b").unwrap();
        assert!(r2[0].backup_path.is_some());

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(settings_path(home.path())).unwrap())
                .unwrap();
        assert_eq!(
            v["env"]["ANTHROPIC_AUTH_TOKEN"],
            serde_json::json!("sk-lgw-b")
        );
    }

    #[test]
    fn backup_and_write_ts_creates_timestamped_backup_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("test.txt");
        std::fs::write(&p, "original").unwrap();

        let backup = backup_and_write_ts(&p, "updated").unwrap();
        assert!(backup.is_some());
        let backup_path = backup.unwrap();
        assert!(backup_path.contains(".bak-"));
        assert!(std::path::Path::new(&backup_path).exists());
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), "original");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "updated");

        // 当文件不存在时返回 None
        let missing = dir.path().join("missing.txt");
        assert!(backup_and_write_ts(&missing, "new").unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&missing).unwrap(), "new");
    }
}
