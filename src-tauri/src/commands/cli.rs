use crate::cli_config::{backup_and_write, claude_code, codex, CliWriteResult};
use std::path::{Path, PathBuf};

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())
}

/// 读取可选配置文件:不存在返回 Ok(None),存在但读取失败(权限/IO)返回 Err。
fn read_file(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

/// 读取现有 CLI 配置为 JSON 文本供前端编辑(可注入 home,便于测试)。
///
/// - `claude_code`:原样返回 settings.json 内容;文件不存在或内容非法 JSON 时返回 `{}`。
/// - `codex`:把 config.toml 解析为 TOML 再序列化为 pretty JSON。
pub(crate) fn read_cli_config_with_home(home: &Path, target: &str) -> Result<String, String> {
    match target {
        "claude_code" => {
            let p = claude_code::settings_path(home);
            let content = read_file(&p)?.unwrap_or_else(|| "{}".to_string());
            // 若当前内容非法 JSON,返回 {} 而非报错(便于从空白开始编辑)
            Ok(serde_json::from_str::<serde_json::Value>(&content)
                .map(|_| content)
                .unwrap_or_else(|_| "{}".to_string()))
        }
        "codex" => {
            let p = codex::config_path(home);
            let content = read_file(&p)?.unwrap_or_default();
            let v: toml::Value = if content.trim().is_empty() {
                toml::Value::Table(toml::map::Map::new())
            } else {
                toml::from_str(&content).map_err(|e| format!("parse config.toml: {e}"))?
            };
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}

/// 读取现有 CLI 配置为 JSON 文本供前端编辑。
#[tauri::command]
pub fn read_cli_config(target: String) -> Result<String, String> {
    read_cli_config_with_home(&home()?, &target)
}

/// 校验并写回 CLI 配置(保留备份,可注入 home,便于测试)。
///
/// 校验 JSON 为对象;写回前对已存在文件保留 `<文件名>.bak` 备份。
pub(crate) fn write_cli_config_content_with_home(
    home: &Path,
    target: &str,
    json_content: &str,
) -> Result<CliWriteResult, String> {
    let v: serde_json::Value =
        serde_json::from_str(json_content).map_err(|e| format!("JSON 解析失败: {e}"))?;
    if !v.is_object() {
        return Err("配置必须是 JSON 对象".into());
    }
    match target {
        "claude_code" => {
            let sp = claude_code::settings_path(home);
            let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
            let backup = backup_and_write(&sp, &pretty)?;
            // 保持 .claude.json onboarding 处理(hasCompletedOnboarding=true),否则 CC 忽略 env
            let dp = claude_code::dotclaude_path(home);
            let dcontent = claude_code::merge_dotclaude(read_file(&dp)?.as_deref())?.0;
            let _ = backup_and_write(&dp, &dcontent)?;
            Ok(CliWriteResult {
                path: sp.display().to_string(),
                changed_keys: vec!["env".to_string()],
                backup_path: backup,
                env_instructions: None,
            })
            // 注:.claude.json 的备份路径暂不展示(与现有 write 行为一致展示主文件备份)
        }
        "codex" => {
            // toml 1.1.4 无 json feature / TryFrom<serde_json::Value>,故用 serde 反序列化转换。
            // toml::Value 实现了 Deserialize,JSON 映射为 TOML 值时干净可用。
            let toml_val: toml::Value =
                serde_json::from_value(v).map_err(|e| format!("JSON→TOML 转换失败: {e}"))?;
            let content = toml::to_string_pretty(&toml_val).map_err(|e| e.to_string())?;
            let cp = codex::config_path(home);
            let backup = backup_and_write(&cp, &content)?;
            Ok(CliWriteResult {
                path: cp.display().to_string(),
                changed_keys: vec![],
                backup_path: backup,
                env_instructions: None,
            })
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}

/// 校验并写回 CLI 配置(保留备份)。
#[tauri::command]
pub fn write_cli_config_content(
    target: String,
    json_content: String,
) -> Result<CliWriteResult, String> {
    write_cli_config_content_with_home(&home()?, &target, &json_content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_cli_config_claude_code_roundtrip() {
        let home = tempfile::tempdir().unwrap();
        let p = claude_code::settings_path(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            r#"{"model":"opus","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8779"}}"#,
        )
        .unwrap();

        let out = read_cli_config_with_home(home.path(), "claude_code").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], serde_json::json!("opus"));
        assert_eq!(
            v["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("http://127.0.0.1:8779")
        );
    }

    #[test]
    fn read_cli_config_claude_code_missing_returns_empty_object() {
        let home = tempfile::tempdir().unwrap();
        let out = read_cli_config_with_home(home.path(), "claude_code").unwrap();
        assert_eq!(out.trim(), "{}");
    }

    #[test]
    fn read_cli_config_codex_toml_to_json() {
        let home = tempfile::tempdir().unwrap();
        let p = codex::config_path(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "model = \"gpt-5\"\nmodel_provider = \"openai\"\n").unwrap();

        let out = read_cli_config_with_home(home.path(), "codex").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], serde_json::json!("gpt-5"));
        assert_eq!(v["model_provider"], serde_json::json!("openai"));
    }

    #[test]
    fn read_cli_config_codex_missing_returns_empty_object() {
        let home = tempfile::tempdir().unwrap();
        let out = read_cli_config_with_home(home.path(), "codex").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.as_object().unwrap().is_empty());
    }

    #[test]
    fn read_cli_config_unknown_target() {
        let home = tempfile::tempdir().unwrap();
        let err = read_cli_config_with_home(home.path(), "nope").unwrap_err();
        assert!(err.contains("未知 CLI 目标"));
    }

    #[test]
    fn write_cli_config_content_rejects_non_object() {
        let home = tempfile::tempdir().unwrap();
        let err = write_cli_config_content_with_home(home.path(), "codex", "[1,2,3]").unwrap_err();
        assert!(err.contains("JSON 对象"));
        let err2 =
            write_cli_config_content_with_home(home.path(), "claude_code", "\"str\"").unwrap_err();
        assert!(err2.contains("JSON 对象"));
    }

    #[test]
    fn write_cli_config_content_rejects_invalid_json() {
        let home = tempfile::tempdir().unwrap();
        let err =
            write_cli_config_content_with_home(home.path(), "codex", "{not json").unwrap_err();
        assert!(err.contains("JSON 解析失败"));
    }

    #[test]
    fn write_cli_config_content_codex_json_to_toml() {
        let home = tempfile::tempdir().unwrap();
        let json = r#"{"model":"gpt-5","model_provider":"llm-gateway","model_providers":{"llm-gateway":{"name":"llm-gateway","base_url":"http://127.0.0.1:8779/v1","env_key":"LLM_GATEWAY_KEY","wire_api":"responses","requires_openai_auth":false}}}"#;
        let r = write_cli_config_content_with_home(home.path(), "codex", json).unwrap();
        assert_eq!(r.path, codex::config_path(home.path()).display().to_string());
        assert!(r.backup_path.is_none()); // 首次写入无备份

        let written = std::fs::read_to_string(codex::config_path(home.path())).unwrap();
        let parsed: toml::Value = toml::from_str(&written).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("gpt-5"));
        assert_eq!(parsed["model_provider"].as_str(), Some("llm-gateway"));
        assert_eq!(
            parsed["model_providers"]["llm-gateway"]["base_url"].as_str(),
            Some("http://127.0.0.1:8779/v1")
        );
        assert_eq!(
            parsed["model_providers"]["llm-gateway"]["requires_openai_auth"].as_bool(),
            Some(false)
        );
    }

    #[test]
    fn write_cli_config_content_codex_roundtrip_json_toml_json() {
        let home = tempfile::tempdir().unwrap();
        let p = codex::config_path(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(
            &p,
            "model = \"gpt-5\"\nmodel_provider = \"openai\"\n[model_providers.openai]\nname = \"OpenAI\"\n",
        )
        .unwrap();

        // read:TOML→JSON
        let json = read_cli_config_with_home(home.path(), "codex").unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["model"], serde_json::json!("gpt-5"));
        assert_eq!(v["model_provider"], serde_json::json!("openai"));

        // edit JSON → write:JSON→TOML
        let mut obj = v.as_object().unwrap().clone();
        obj.insert("model".into(), serde_json::json!("gpt-5.2"));
        let edited = serde_json::to_string(&serde_json::Value::Object(obj)).unwrap();
        let r = write_cli_config_content_with_home(home.path(), "codex", &edited).unwrap();
        assert!(r.backup_path.is_some()); // 已存在文件,写入产生备份

        // read back:TOML→JSON,用户编辑值保留、无关键保留
        let json2 = read_cli_config_with_home(home.path(), "codex").unwrap();
        let v2: serde_json::Value = serde_json::from_str(&json2).unwrap();
        assert_eq!(v2["model"], serde_json::json!("gpt-5.2"));
        assert_eq!(v2["model_provider"], serde_json::json!("openai"));
        assert_eq!(
            v2["model_providers"]["openai"]["name"],
            serde_json::json!("OpenAI")
        );
    }

    #[test]
    fn write_cli_config_content_creates_backup() {
        let home = tempfile::tempdir().unwrap();
        let p = claude_code::settings_path(home.path());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"model":"opus"}"#).unwrap();

        let r = write_cli_config_content_with_home(
            home.path(),
            "claude_code",
            r#"{"model":"sonnet","env":{"A":"1"}}"#,
        )
        .unwrap();
        assert!(r.backup_path.is_some());
        assert!(p.with_file_name("settings.json.bak").exists());

        // 主文件内容为新 JSON
        let written = std::fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(v["model"], serde_json::json!("sonnet"));

        // .claude.json onboarding 同步创建
        assert!(claude_code::dotclaude_path(home.path()).exists());
        let dot = std::fs::read_to_string(claude_code::dotclaude_path(home.path())).unwrap();
        let dv: serde_json::Value = serde_json::from_str(&dot).unwrap();
        assert_eq!(dv["hasCompletedOnboarding"], serde_json::json!(true));
    }

    #[test]
    fn write_cli_config_content_unknown_target() {
        let home = tempfile::tempdir().unwrap();
        let err = write_cli_config_content_with_home(home.path(), "nope", "{}").unwrap_err();
        assert!(err.contains("未知 CLI 目标"));
    }
}
