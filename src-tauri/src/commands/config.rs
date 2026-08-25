use crate::cli_config::{claude_code, codex, CliWriteResult};
use crate::config::backup;
use crate::config::restore;
use crate::config::settings;
use crate::proxy::state::AppState;
use serde::Serialize;
use serde_json::json;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

/// 在新线程启动网关(独立 tokio runtime),并把 bound_addr / gateway_handle 写入 state。
/// 返回绑定结果 channel:成功为实际绑定地址,失败为错误(仅发送一次)。
/// 供启动与重启共用;调用方可丢弃返回值(仅当需要感知绑定结果时再接收)。
pub(crate) fn spawn_gateway(
    state: &AppState,
) -> std::sync::mpsc::Receiver<Result<SocketAddr, String>> {
    spawn_gateway_with_port(state, None)
}

/// 同 spawn_gateway,但可显式指定起始端口(重启失败恢复时用旧端口,不改 preferred_port)。
fn spawn_gateway_with_port(
    state: &AppState,
    port_override: Option<u16>,
) -> std::sync::mpsc::Receiver<Result<SocketAddr, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let start_port = port_override.unwrap_or(state.app.read().preferred_port);
            match crate::proxy::server::start(state.clone(), start_port).await {
                Ok((handle, addr)) => {
                    *state.bound_addr.write() = Some(addr);
                    // JoinHandle 不可 Clone,故把 handle 留在 state 中供 restart 命令 abort。
                    *state.gateway_handle.write() = Some(handle);
                    let _ = tx.send(Ok(addr));
                    // 保持 runtime 存活直到服务结束:abort 后 is_finished 变 true,
                    // 重启时 handle 被 take 置空 → None 也视为结束,线程正常退出(不 panic)。
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
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
                Err(e) => {
                    log::error!("no available port in {}..=8787: {}", start_port, e);
                    let _ = tx.send(Err(e));
                }
            }
        });
    });
    rx
}

/// 重启网关:abort 旧服务 → 等旧端口真正释放 → 用当前 preferred_port 重新启动并更新 bound_addr。
/// 新服务绑定失败时返回 Err,并尝试用旧端口恢复网关,避免网关彻底下线。
fn restart_gateway_inner(state: &AppState) -> Result<(), String> {
    // 1. 记录旧绑定地址(失败时用于恢复),abort 旧实例
    let old_bound = *state.bound_addr.read();
    let old_handle = state.gateway_handle.write().take();
    if let Some(h) = old_handle.as_ref() {
        h.abort();
    }
    *state.bound_addr.write() = None;

    // 2. 等待旧服务真正释放端口:abort 后 is_finished 变 true → listener 已 drop。
    //    否则新服务在同一端口上会静默绑定到 preferred_port+n。
    if let Some(h) = old_handle {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !h.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // 3. 启动新网关并等待绑定结果;失败/超时则恢复旧网关并返回 Err
    let rx = spawn_gateway(state);
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(_addr)) => Ok(()),
        Ok(Err(e)) => {
            restore_gateway_after_failed_restart(state, old_bound);
            Err(format!("网关重启失败: {}", e))
        }
        Err(_) => {
            restore_gateway_after_failed_restart(state, old_bound);
            Err("网关重启超时".to_string())
        }
    }
}

/// 重启失败后尝试用旧端口恢复网关(不改 preferred_port,仅恢复服务)。
fn restore_gateway_after_failed_restart(state: &AppState, old_bound: Option<SocketAddr>) {
    let Some(addr) = old_bound else {
        log::warn!("no previous gateway to restore after failed restart");
        return;
    };
    log::warn!("restart failed, restoring gateway on old port {}", addr);
    let rx = spawn_gateway_with_port(state, Some(addr.port()));
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(_)) => log::info!("gateway restored on {}", addr),
        Ok(Err(e)) => log::error!("gateway restore failed on {}: {}", addr, e),
        Err(_) => log::error!("gateway restore timed out on {}", addr),
    }
}

/// 重启网关(供前端调用):abort 旧服务 → 等旧端口释放 → 用当前 preferred_port 重新启动。
/// 新服务绑定失败时返回 Err(前端显示错误而非“网关已重启”),并尝试恢复旧网关。
#[tauri::command]
pub async fn restart_gateway(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restart_gateway_inner(&state))
        .await
        .map_err(|e| e.to_string())?
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
    pub minimize_to_tray: bool,
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
    let cfg = state.app.read();
    AppConfigInfo {
        preferred_port: cfg.preferred_port,
        bound_addr: state.bound_addr.read().map(|a| a.to_string()),
        minimize_to_tray: cfg.minimize_to_tray,
    }
}

#[tauri::command]
pub fn set_minimize_to_tray(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.app.write().minimize_to_tray = enabled;
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("app.minimize_to_tray", json!(enabled));
        if let Err(e) = store.save() {
            log::error!("failed to save minimize_to_tray store: {}", e);
        }
    }
    Ok(())
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

/// 把当前网关地址与所选密钥合并进给定的 Claude Code settings.json JSON 文本：
/// 仅改写 env.ANTHROPIC_BASE_URL / env.ANTHROPIC_AUTH_TOKEN，保留其余全部键，
/// 返回合并后的 JSON（不落盘，交由前端编辑确认后保存）。
#[tauri::command]
pub fn merge_gateway_env(
    state: State<AppState>,
    json_content: String,
    api_key_id: String,
) -> Result<String, String> {
    merge_gateway_env_inner(&state, &json_content, &api_key_id)
}

pub(crate) fn merge_gateway_env_inner(
    state: &AppState,
    json_content: &str,
    api_key_id: &str,
) -> Result<String, String> {
    let base_url = resolve_base_url(*state.bound_addr.read())?;
    let keys = state.repo.list_api_keys().map_err(|e| e.to_string())?;
    let key = keys
        .iter()
        .find(|k| k.id == api_key_id)
        .ok_or_else(|| "API 密钥不存在".to_string())?;
    let (merged, _changed) = claude_code::merge_settings(Some(json_content), &base_url, &key.key)?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn merge_gateway_env_inner_sets_only_env_vars() {
        use crate::db::models::ApiKey;
        use crate::db::Db;

        let db = Db::new_in_memory().unwrap();
        let repo = crate::db::repository::Repository::new(db.clone());
        repo.insert_api_key(&ApiKey {
            id: "k1".into(),
            key: "sk-lgw-abc".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        })
        .unwrap();
        let state = AppState::new(db);
        *state.bound_addr.write() = Some("127.0.0.1:8779".parse().unwrap());

        let out = merge_gateway_env_inner(&state, r#"{"model":"opus","env":{"OTHER":"1"}}"#, "k1")
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], serde_json::json!("opus"));
        assert_eq!(v["env"]["OTHER"], serde_json::json!("1"));
        assert_eq!(
            v["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("http://127.0.0.1:8779")
        );
        assert_eq!(
            v["env"]["ANTHROPIC_AUTH_TOKEN"],
            serde_json::json!("sk-lgw-abc")
        );

        let err = merge_gateway_env_inner(&state, "{}", "missing").unwrap_err();
        assert!(err.contains("API 密钥不存在"));
    }

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

    /// 停止网关并清空 bound_addr(测试清理用,避免后台线程跨测试占用端口)。
    fn stop_gateway(state: &AppState) {
        if let Some(h) = state.gateway_handle.write().take() {
            h.abort();
        }
        *state.bound_addr.write() = None;
        std::thread::sleep(Duration::from_millis(100));
    }

    /// 本机网关请求不走系统代理(与网关自身 reqwest 客户端一致),避免本机代理返回 503。
    fn no_proxy_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build no_proxy client")
    }

    /// 断言 /health 返回 "ok"。
    fn assert_health_ok(addr: SocketAddr) {
        let client = no_proxy_client();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let body = rt.block_on(async move {
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

    /// 连接 /health 是否失败(端口已释放时应为 true)。
    fn health_fails(addr: SocketAddr) -> bool {
        let client = no_proxy_client();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move { client.get(format!("http://{}/health", addr)).send().await })
            .is_err()
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
        assert!(
            state.gateway_handle.read().is_some(),
            "handle should be stored"
        );

        // 新服务实际可访问 /health
        assert_health_ok(addr);
        stop_gateway(&state);
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

        assert_health_ok(addr2);
        // 旧端口已释放(重启后 addr1 上不应再提供服务)
        assert!(health_fails(addr1), "old gateway should have been aborted");
        stop_gateway(&state);
    }

    #[test]
    fn restart_failure_returns_err_and_restores_old_gateway() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        spawn_gateway(&state);
        let addr1 = wait_bound(&state).expect("gateway should bind within 5s");
        assert_eq!(addr1.port(), 8779, "default preferred_port is 8779");

        // 占住 8780..=8787,让 server::start(8780) 全范围扫描失败
        let mut blockers = vec![];
        for port in 8780..=8787 {
            blockers.push(std::net::TcpListener::bind(("127.0.0.1", port)).unwrap());
        }

        // 重启应返回 Err 而非静默成功
        state.app.write().preferred_port = 8780;
        let err = restart_gateway_inner(&state).expect_err("restart should fail");
        assert!(err.contains("重启失败"), "unexpected err: {}", err);

        // 失败后应尝试用旧端口恢复:网关重新在 8779 上提供服务
        let restored = wait_bound(&state).expect("gateway should be restored within 5s");
        assert_eq!(
            restored, addr1,
            "restored gateway should reuse old bound addr"
        );
        assert_health_ok(restored);

        stop_gateway(&state);
        drop(blockers);
    }
}
