use crate::db::models::McpServer;
use crate::mcp_client;
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerView {
    pub server: McpServer,
    pub connected: bool,
}

#[tauri::command]
pub fn list_mcp_servers(state: State<AppState>) -> Result<Vec<McpServerView>, String> {
    list_mcp_servers_with_state(&state)
}

pub(crate) fn list_mcp_servers_with_state(state: &AppState) -> Result<Vec<McpServerView>, String> {
    let clients = state.mcp_clients.read();
    state
        .repo
        .list_mcp_servers()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|server| {
            let connected = clients
                .get(&server.id)
                .map(|h| !h.is_finished())
                .unwrap_or(false);
            Ok(McpServerView { server, connected })
        })
        .collect()
}

#[tauri::command]
pub fn upsert_mcp_server(state: State<AppState>, server: McpServer) -> Result<McpServer, String> {
    upsert_mcp_server_with_state(&state, server)
}

pub(crate) fn upsert_mcp_server_with_state(
    state: &AppState,
    mut server: McpServer,
) -> Result<McpServer, String> {
    validate_server_spec(&server.server_config)?;
    if server.id.is_empty() {
        server.id = uuid::Uuid::new_v4().to_string();
    }
    let now = chrono::Utc::now().timestamp();
    if server.created_at == 0 {
        server.created_at = now;
    }
    server.updated_at = now;
    state
        .repo
        .upsert_mcp_server(&server)
        .map_err(|e| e.to_string())?;
    // 编辑配置后旧连接可能已过期：断开该 id 的活跃连接，避免陈旧连接继续运行。
    if let Some(handle) = state.mcp_clients.write().remove(&server.id) {
        handle.abort();
    }
    Ok(server)
}

fn validate_server_spec(server_config: &serde_json::Value) -> Result<(), String> {
    let typ = server_config
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio");
    match typ {
        "http" | "sse" => {
            let url = server_config
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("");
            if url.is_empty() {
                return Err("http 类型需要 url".to_string());
            }
        }
        _ => {
            let command = server_config
                .get("command")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            if command.is_empty() {
                return Err("stdio 类型需要 command".to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    disconnect_mcp_server_with_state(&state, &id).await?;
    state.repo.delete_mcp_server(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_mcp_server_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    toggle_mcp_server_enabled_with_state(&state, id, enabled).await
}

pub(crate) async fn toggle_mcp_server_enabled_with_state(
    state: &AppState,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        connect_mcp_server_with_state(state, &id).await?;
        state
            .repo
            .set_mcp_server_enabled(&id, true)
            .map_err(|e| e.to_string())?;
    } else {
        state
            .repo
            .set_mcp_server_enabled(&id, false)
            .map_err(|e| e.to_string())?;
        disconnect_mcp_server_with_state(state, &id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    connect_mcp_server_with_state(&state, &id).await
}

pub(crate) async fn connect_mcp_server_with_state(
    state: &AppState,
    id: &str,
) -> Result<(), String> {
    {
        let clients = state.mcp_clients.read();
        if clients.get(id).map(|h| !h.is_finished()).unwrap_or(false) {
            return Ok(());
        }
    }
    let server = state
        .repo
        .get_mcp_server(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "MCP server 不存在".to_string())?;
    let (handle, rx) = mcp_client::spawn_connection(&server.server_config, &server.name)?;
    match mcp_client::await_handshake(&handle, rx, &server.name).await {
        Ok(()) => {
            state.mcp_clients.write().insert(id.to_string(), handle);
            Ok(())
        }
        Err(msg) => {
            // await_handshake 失败路径已 abort；此处兜底确保 task 不再运行。
            handle.abort();
            Err(msg)
        }
    }
}

#[tauri::command]
pub async fn disconnect_mcp_server(state: State<'_, AppState>, id: String) -> Result<(), String> {
    disconnect_mcp_server_with_state(&state, &id).await
}

pub(crate) async fn disconnect_mcp_server_with_state(
    state: &AppState,
    id: &str,
) -> Result<(), String> {
    if let Some(handle) = state.mcp_clients.write().remove(id) {
        handle.abort();
    }
    Ok(())
}

/// 启动时重连所有 `enabled=true` 的 MCP server（尽力而为）。
///
/// 仅在启动路径调用：逐台复用 `connect_mcp_server_with_state` 的完整握手路径；
/// 任何失败仅记录日志，绝不让启动失败或阻塞。已在 `mcp_clients` 中的连接会被跳过。
pub(crate) async fn reconnect_enabled(state: &AppState) {
    let servers = match state.repo.list_mcp_servers() {
        Ok(servers) => servers,
        Err(e) => {
            log::error!("mcp reconnect: list servers failed: {}", e);
            return;
        }
    };
    for server in servers {
        if !server.enabled {
            continue;
        }
        if let Err(e) = connect_mcp_server_with_state(state, &server.id).await {
            log::warn!(
                "mcp reconnect {} ({}) failed: {}",
                server.name,
                server.id,
                e
            );
        }
    }
}

#[tauri::command]
pub async fn test_mcp_connection(state: State<'_, AppState>, id: String) -> Result<String, String> {
    test_mcp_connection_with_state(&state, id).await
}

pub(crate) async fn test_mcp_connection_with_state(
    state: &AppState,
    id: String,
) -> Result<String, String> {
    let server = state
        .repo
        .get_mcp_server(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "MCP server 不存在".to_string())?;
    mcp_client::test_connection(&server.server_config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::McpServer;
    use crate::db::Db;

    fn stdio_server(id: &str, command: &str) -> McpServer {
        McpServer {
            id: id.into(),
            name: "test".into(),
            server_config: serde_json::json!({ "command": command }),
            description: None,
            enabled: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn upsert_rejects_stdio_without_command() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let server = McpServer {
            id: "s1".into(),
            name: "test".into(),
            server_config: serde_json::json!({}),
            description: None,
            enabled: false,
            created_at: 0,
            updated_at: 0,
        };
        let err = upsert_mcp_server_with_state(&state, server).unwrap_err();
        assert_eq!(err, "stdio 类型需要 command");
    }

    #[test]
    fn upsert_rejects_http_without_url() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let server = McpServer {
            id: "s1".into(),
            name: "test".into(),
            server_config: serde_json::json!({ "type": "http" }),
            description: None,
            enabled: false,
            created_at: 0,
            updated_at: 0,
        };
        let err = upsert_mcp_server_with_state(&state, server).unwrap_err();
        assert_eq!(err, "http 类型需要 url");
    }

    #[tokio::test]
    async fn toggle_enabled_state_sync() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        // 该命令在任何 OS 上都无法启动 → connect 握手必然失败
        let server = stdio_server("s1", "this-command-does-not-exist-xyz");
        upsert_mcp_server_with_state(&state, server).unwrap();

        // 启用时 connect 失败 → toggle 返回 Err，DB enabled 保持 false
        let err = toggle_mcp_server_enabled_with_state(&state, "s1".to_string(), true)
            .await
            .unwrap_err();
        assert!(
            err.contains("启动进程失败") || err.contains("连接失败"),
            "unexpected error: {err}"
        );
        assert!(!state.repo.get_mcp_server("s1").unwrap().unwrap().enabled);

        // 禁用路径：DB enabled 翻转为 false
        toggle_mcp_server_enabled_with_state(&state, "s1".to_string(), false)
            .await
            .unwrap();
        assert!(!state.repo.get_mcp_server("s1").unwrap().unwrap().enabled);
    }

    #[tokio::test]
    async fn test_connection_invalid_config_errors() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let server = McpServer {
            id: "s1".into(),
            name: "test".into(),
            server_config: serde_json::json!({ "type": "stdio" }),
            description: None,
            enabled: false,
            created_at: 0,
            updated_at: 0,
        };
        state.repo.upsert_mcp_server(&server).unwrap();
        let err = test_mcp_connection_with_state(&state, "s1".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, "stdio 类型需要 command");
    }

    #[tokio::test]
    async fn test_connection_http_without_url_errors() {
        // 走 spawn_connection 的 http 校验层：无 url 直接返回错误（此前未覆盖）
        let err = mcp_client::test_connection(&serde_json::json!({ "type": "http" }))
            .await
            .unwrap_err();
        assert_eq!(err, "http 类型需要 url");
    }

    #[tokio::test]
    async fn reconnect_enabled_attempts_enabled_only_and_never_panics() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        // enabled=true 且命令必然启动失败 → 触发 connect 尝试，失败不 panic、不进入 mcp_clients
        let mut enabled = stdio_server("s1", "this-command-does-not-exist-xyz");
        enabled.enabled = true;
        state.repo.upsert_mcp_server(&enabled).unwrap();
        // enabled=false → 启动重连必须跳过，不触发任何 connect
        state
            .repo
            .upsert_mcp_server(&stdio_server("s2", "this-command-does-not-exist-xyz"))
            .unwrap();

        reconnect_enabled(&state).await;

        // 握手失败路径不得把 handle 记入 mcp_clients，也不得 panic
        assert!(
            state.mcp_clients.read().is_empty(),
            "failed handshake must not be tracked in mcp_clients"
        );
        // DB 记录原样保留
        assert!(state.repo.get_mcp_server("s1").unwrap().unwrap().enabled);
        assert!(!state.repo.get_mcp_server("s2").unwrap().unwrap().enabled);
    }
}
