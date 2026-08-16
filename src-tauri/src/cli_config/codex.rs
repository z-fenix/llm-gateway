use super::{backup_and_write, CliWriteResult};
use std::path::{Path, PathBuf};

pub const ENV_KEY: &str = "LLM_GATEWAY_KEY";
pub const PROVIDER: &str = "llm-gateway";

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}

/// 合并 config.toml, 设 model_provider 与 [model_providers.llm-gateway], 保留其它键/provider。
pub fn merge_config(existing: Option<&str>, base_url: &str) -> Result<(String, Vec<String>), String> {
    let mut doc: toml::Value = match existing {
        Some(s) if !s.trim().is_empty() => toml::from_str(s).map_err(|e| format!("parse config.toml: {e}"))?,
        _ => toml::Value::Table(toml::map::Map::new()),
    };
    let root = doc.as_table_mut().ok_or_else(|| "config.toml root not a table".to_string())?;
    let mut changed = vec![];

    if root.get("model_provider").and_then(|v| v.as_str()) != Some(PROVIDER) {
        root.insert("model_provider".to_string(), toml::Value::String(PROVIDER.into()));
        changed.push("model_provider".into());
    }
    let providers = root
        .entry("model_providers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !providers.is_table() {
        *providers = toml::Value::Table(toml::map::Map::new());
    }
    let providers = providers.as_table_mut().unwrap();
    let block = providers
        .entry(PROVIDER)
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !block.is_table() {
        *block = toml::Value::Table(toml::map::Map::new());
    }
    let block = block.as_table_mut().unwrap();
    let want = [
        ("name", toml::Value::String(PROVIDER.into())),
        ("base_url", toml::Value::String(base_url.into())),
        ("env_key", toml::Value::String(ENV_KEY.into())),
        ("wire_api", toml::Value::String("responses".into())),
        ("requires_openai_auth", toml::Value::Boolean(false)),
    ];
    for (k, val) in want {
        if block.get(k) != Some(&val) {
            block.insert(k.to_string(), val);
            changed.push(format!("model_providers.{}.{}", PROVIDER, k));
        }
    }
    toml::to_string_pretty(&doc)
        .map(|s| (s, changed))
        .map_err(|e| format!("serialize config.toml: {e}"))
}

/// 按平台给设置环境变量的命令文本(write_env=false 时展示)。
pub fn env_instructions(token: &str) -> String {
    if cfg!(windows) {
        format!("setx {ENV_KEY} \"{token}\"   :: 然后重开终端/Codex")
    } else {
        format!("echo 'export {ENV_KEY}=\"{token}\"' >> ~/.profile   # 然后重开终端/Codex")
    }
}

/// 写用户级环境变量。Windows 用 setx; unix 追加/替换 ~/.profile 的 export 行。
pub fn write_env_var(home: &Path, token: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = home;
        let status = std::process::Command::new("setx")
            .args([ENV_KEY, token])
            .status()
            .map_err(|e| format!("run setx: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("setx exited with {status}"))
        }
    }
    #[cfg(not(windows))]
    {
        let profile = home.join(".profile");
        let existing = match std::fs::read_to_string(&profile) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(format!("read {}: {}", profile.display(), e)),
        };
        let line = format!("export {ENV_KEY}=\"{token}\"");
        let export_prefix = format!("export {ENV_KEY}=");
        let mut kept: Vec<String> = existing
            .lines()
            .filter(|l| !l.trim_start().starts_with(&export_prefix))
            .map(|l| l.to_string())
            .collect();
        kept.push(line);
        std::fs::write(&profile, kept.join("\n") + "\n")
            .map_err(|e| format!("write {}: {e}", profile.display()))
    }
}

fn read_opt(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

pub fn write(home: &Path, base_url: &str, token: &str, write_env: bool) -> Result<CliWriteResult, String> {
    let cp = config_path(home);
    let existing = read_opt(&cp)?;
    let (content, changed) = merge_config(existing.as_deref(), base_url)?;
    let backup = backup_and_write(&cp, &content)?;
    let env_instructions = if write_env {
        write_env_var(home, token)?;
        None
    } else {
        Some(env_instructions(token))
    };
    Ok(CliWriteResult {
        path: cp.display().to_string(),
        changed_keys: changed,
        backup_path: backup,
        env_instructions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_config_sets_provider_preserves_others() {
        let existing = r#"
model = "gpt-5"
[model_providers.other]
name = "Other"
base_url = "https://x/v1"
"#;
        let (out, changed) = merge_config(Some(existing), "http://127.0.0.1:8779/v1").unwrap();
        let v: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(v["model_provider"].as_str(), Some("llm-gateway"));
        assert_eq!(v["model_providers"]["llm-gateway"]["base_url"].as_str(), Some("http://127.0.0.1:8779/v1"));
        assert_eq!(v["model_providers"]["llm-gateway"]["wire_api"].as_str(), Some("responses"));
        assert_eq!(v["model_providers"]["llm-gateway"]["env_key"].as_str(), Some("LLM_GATEWAY_KEY"));
        assert_eq!(v["model_providers"]["other"]["name"].as_str(), Some("Other")); // 其它 provider 保留
        assert_eq!(v["model"].as_str(), Some("gpt-5"));                              // 顶层无关键保留
        assert!(changed.iter().any(|k| k.contains("model_providers.llm-gateway")));
    }

    #[test]
    fn merge_config_handles_empty() {
        let (out, _) = merge_config(None, "http://x/v1").unwrap();
        let v: toml::Value = toml::from_str(&out).unwrap();
        assert_eq!(v["model_provider"].as_str(), Some("llm-gateway"));
    }

    #[test]
    fn merge_config_does_not_embed_token() {
        let (out, _) = merge_config(None, "http://x/v1").unwrap();
        assert!(!out.contains("sk-secret"));
        assert!(!out.contains("LLM_GATEWAY_KEY_VALUE"));
    }

    #[test]
    fn env_instructions_format() {
        let s = env_instructions("sk-abc");
        assert!(s.contains("LLM_GATEWAY_KEY"));
        assert!(s.contains("sk-abc"));
    }

    #[test]
    fn write_creates_config_and_instructions() {
        let home = tempfile::tempdir().unwrap();
        let r = write(home.path(), "http://127.0.0.1:8779/v1", "sk-lgw-xyz", false).unwrap();
        assert_eq!(r.path, config_path(home.path()).display().to_string());
        assert!(r.backup_path.is_none());
        assert!(r.env_instructions.as_ref().unwrap().contains("sk-lgw-xyz"));

        let written = std::fs::read_to_string(config_path(home.path())).unwrap();
        let v: toml::Value = toml::from_str(&written).unwrap();
        assert_eq!(v["model_provider"].as_str(), Some("llm-gateway"));
        assert_eq!(v["model_providers"]["llm-gateway"]["base_url"].as_str(), Some("http://127.0.0.1:8779/v1"));
        assert!(!written.contains("sk-lgw-xyz"));
    }

    #[test]
    fn write_preserves_existing_and_creates_backup() {
        let home = tempfile::tempdir().unwrap();
        let cp = config_path(home.path());
        std::fs::create_dir_all(cp.parent().unwrap()).unwrap();
        std::fs::write(&cp,
            r#"model = "gpt-4"
[model_providers.openai]
name = "OpenAI"
"#,
        )
        .unwrap();

        let r = write(home.path(), "http://127.0.0.1:8779/v1", "sk-lgw-xyz", false).unwrap();
        assert!(r.backup_path.is_some());

        let written = std::fs::read_to_string(&cp).unwrap();
        let v: toml::Value = toml::from_str(&written).unwrap();
        assert_eq!(v["model"].as_str(), Some("gpt-4"));
        assert_eq!(v["model_providers"]["openai"]["name"].as_str(), Some("OpenAI"));
        assert_eq!(v["model_provider"].as_str(), Some("llm-gateway"));
    }

    #[test]
    fn read_opt_missing_returns_none() {
        let home = tempfile::tempdir().unwrap();
        let p = config_path(home.path());
        assert_eq!(read_opt(&p).unwrap(), None);
    }

    #[test]
    fn read_opt_unreadable_returns_err() {
        let home = tempfile::tempdir().unwrap();
        let p = config_path(home.path());
        std::fs::create_dir_all(&p).unwrap();
        let err = read_opt(&p).unwrap_err();
        assert!(err.contains("read"));
        assert!(err.contains(p.display().to_string().as_str()));
    }
}
