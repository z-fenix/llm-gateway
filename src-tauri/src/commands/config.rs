use crate::cli_config::{claude_code, codex, CliWriteResult};
use crate::config::backup;
use crate::config::restore;
use crate::config::settings;
use crate::proxy::state::AppState;
use serde::Serialize;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

/// 在新线程启动网关(独立 tokio runtime),并把 bound_addr / gateway_handle 写入 state。
/// 供启动与重启共用。
pub(crate) fn spawn_gateway(state: &AppState) {
    let state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let start_port = state.app.read().preferred_port;
            match crate::proxy::server::start(state.clone(), start_port).await {
                Ok((handle, addr)) => {
                    *state.bound_addr.write() = Some(addr);
                    // 不 panic:重启时 abort 会让 is_finished 变为 true,线程正常退出。
                    // JoinHandle 不可 Clone,故用轮询 is_finished 保持 runtime 存活,
                    // 同时把 handle 留在 state 中供 restart 命令 abort。
                    *state.gateway_handle.write() = Some(handle);
                    // 保持 runtime 存活直到服务结束:abort 后 is_finished 为 true,
                    // 重启时 handle 被 take 置空 → None 也视为结束,线程正常退出。
                    loop {
                        let done = state
                            .gateway_handle
                            .read()
                            .as_ref()
                            .map(|h| h.is_finished())
                            .unwrap_or(true);
                        if done {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
                Err(e) => {
                    log::error!("no available port in {}..=8787: {}", start_port, e);
                }
            }
        });
    });
}

/// 重启网关:abort 旧服务 → 用当前 preferred_port 重新启动并更新 bound_addr。
pub(crate) fn restart_gateway_inner(state: &AppState) -> Result<(), String> {
    // abort 旧实例
    if let Some(h) = state.gateway_handle.write().take() {
        h.abort();
    }
    *state.bound_addr.write() = None;
    spawn_gateway(state);
    Ok(())
}

/// 重启网关(供前端调用):abort 旧服务 → 用当前 preferred_port 重新启动并更新 bound_addr。
#[tauri::command]
pub fn restart_gateway(state: State<AppState>) -> Result<(), String> {
    restart_gateway_inner(state.inner())
}

#[tauri::command]
pub fn export_config(state: State<AppState>, path: String) -> Result<u64, String> {
    backup::export_to_file(&state, &PathBuf::from(path))
}

#[tauri::command]
pub fn default_export_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("llm-gateway-config.json").display().to_string()
}

#[tauri::command]
pub fn preview_import(
    state: State<AppState>,
    path: String,
) -> Result<restore::ImportPreview, String> {
    let bundle = restore::parse_bundle(&PathBuf::from(&path))?;
    Ok(restore::preview(&state, &bundle))
}

#[tauri::command]
pub fn import_config(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    strategy: String,
) -> Result<restore::ImportResult, String> {
    if strategy != "skip" && strategy != "overwrite" {
        return Err("strategy 须为 skip 或 overwrite".into());
    }
    let bundle = restore::parse_bundle(&PathBuf::from(&path))?;
    let result = restore::import(&state, &bundle, &strategy)?;

    match app.store("store.bin") {
        Ok(store) => {
            let sec = state.security.read().clone();
            let _ = store.set("security.enabled", json!(sec.enabled));
            let _ = store.set("security.mode", json!(sec.mode));
            let _ = store.set("security.scan_request", json!(sec.scan_request));
            let _ = store.set("security.scan_response", json!(sec.scan_response));
            let _ = store.set("security.scan_unicode", json!(sec.scan_unicode));
            let _ = store.set("security.scan_tools", json!(sec.scan_tools));
            let _ = store.set("security.scan_network", json!(sec.scan_network));
            let _ = store.set("security.redact_secrets", json!(sec.redact_secrets));
            let _ = store.set("security.block_on_critical", json!(sec.block_on_critical));
            let _ = store.set("security.max_scan_bytes", json!(sec.max_scan_bytes));
            match state.fallback.read().clone() {
                Some((channel_id, model)) => {
                    let _ = store.set(
                        "fallback",
                        json!({"channel_id": channel_id, "model": model}),
                    );
                }
                None => {
                    let _ = store.set("fallback", serde_json::Value::Null);
                }
            }
            let _ = store.set("app.preferred_port", json!(state.app.read().preferred_port));
            if let Err(e) = store.save() {
                log::error!("failed to save store after import: {}", e);
            }
        }
        Err(e) => {
            log::error!("import: cannot open store.bin to persist settings: {}", e);
        }
    }

    Ok(result)
}

#[derive(Serialize)]
pub struct AppConfigInfo {
    pub preferred_port: u16,
    pub bound_addr: Option<String>,
}

#[derive(Serialize)]
pub struct CliTargetInfo {
    pub target: String,
    pub configured: bool,
    pub path: String,
}

pub fn resolve_base_url(bound: Option<SocketAddr>) -> Result<String, String> {
    bound
        .map(|a| format!("http://{}", a))
        .ok_or_else(|| "网关未启动".to_string())
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())
}

#[tauri::command]
pub fn get_app_config(state: State<AppState>) -> AppConfigInfo {
    AppConfigInfo {
        preferred_port: state.app.read().preferred_port,
        bound_addr: state.bound_addr.read().map(|a| a.to_string()),
    }
}

#[tauri::command]
pub fn set_preferred_port(app: AppHandle, state: State<AppState>, port: u16) -> Result<(), String> {
    if !(settings::MIN_PORT..=settings::MAX_PORT).contains(&port) {
        return Err(format!(
            "端口须在 {}..={}",
            settings::MIN_PORT,
            settings::MAX_PORT
        ));
    }
    state.app.write().preferred_port = port;
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("app.preferred_port", json!(port));
        if let Err(e) = store.save() {
            log::error!("failed to save preferred_port store: {}", e);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_cli_targets(state: State<AppState>) -> Vec<CliTargetInfo> {
    let bound = state.bound_addr.read().map(|a| a.to_string());
    let mut out = vec![];
    if let Ok(h) = home() {
        let sp = claude_code::settings_path(&h);
        let configured = std::fs::read_to_string(&sp)
            .ok()
            .zip(bound.clone())
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo {
            target: "claude_code".into(),
            configured,
            path: sp.display().to_string(),
        });
        let cp = codex::config_path(&h);
        let configured = std::fs::read_to_string(&cp)
            .ok()
            .zip(bound)
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo {
            target: "codex".into(),
            configured,
            path: cp.display().to_string(),
        });
    }
    out
}

#[tauri::command]
pub fn write_cli_config(
    state: State<AppState>,
    target: String,
    api_key_id: String,
    write_env: bool,
) -> Result<Vec<CliWriteResult>, String> {
    let base_url = resolve_base_url(*state.bound_addr.read())?;
    let keys = state.repo.list_api_keys().map_err(|e| e.to_string())?;
    let key = keys
        .into_iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| "API 密钥不存在".to_string())?;
    let h = home()?;
    match target.as_str() {
        "claude_code" => claude_code::write(&h, &base_url, &key.key),
        "codex" => {
            let r = codex::write(&h, &format!("{}/v1", base_url), &key.key, write_env)?;
            Ok(vec![r])
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::time::Duration;

    /// 轮询等待 bound_addr 变为 Some 并返回地址(最多 ~5s)。
    fn wait_bound(state: &AppState) -> Option<SocketAddr> {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(addr) = *state.bound_addr.read() {
                return Some(addr);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 本机网关请求不走系统代理(与网关自身 reqwest 客户端一致),避免本机代理返回 503。
    fn no_proxy_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build no_proxy client")
    }

    #[test]
    fn resolve_base_url_requires_bound() {
        assert!(resolve_base_url(None).is_err());
        let addr: std::net::SocketAddr = "127.0.0.1:8779".parse().unwrap();
        assert_eq!(
            resolve_base_url(Some(addr)).unwrap(),
            "http://127.0.0.1:8779"
        );
    }

    #[test]
    fn spawn_gateway_starts_server_and_sets_bound_addr() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        // 默认 8779;server::start 在占用时向上扫描,RUST_TEST_THREADS=1 避免并行冲突
        spawn_gateway(&state);

        let addr = wait_bound(&state).expect("gateway should bind within 5s");
        assert!(state.gateway_handle.read().is_some(), "handle should be stored");

        // 新服务实际可访问 /health
        let client = no_proxy_client();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let body = rt
            .block_on(async move {
                client
                    .get(format!("http://{}/health", addr))
                    .send()
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .text()
                    .await
                    .unwrap()
            });
        assert_eq!(body, "ok");
    }

    #[test]
    fn restart_after_port_change_binds_new_addr() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        spawn_gateway(&state);
        let addr1 = wait_bound(&state).expect("gateway should bind within 5s");

        // 改端口后重启,新服务应绑定到新端口并可访问
        state.app.write().preferred_port = 8782;
        restart_gateway_inner(&state).expect("restart should succeed");
        let addr2 = wait_bound(&state).expect("gateway should re-bind within 5s");

        let client = no_proxy_client();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let body = client
                .get(format!("http://{}/health", addr2))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .text()
                .await
                .unwrap();
            assert_eq!(body, "ok");
        });

        // 旧端口已释放(重启后 addr1 上不应再提供服务)
        let client = no_proxy_client();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let old_dead = rt
            .block_on(async move { client.get(format!("http://{}/health", addr1)).send().await })
            .is_err();
        assert!(old_dead, "old gateway should have been aborted");
    }
}
