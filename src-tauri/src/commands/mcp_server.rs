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
pub fn upsert_mcp_server(
    state: State<AppState>,
    server: McpServer,
) -> Result<McpServer, String> {
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
    state.repo.upsert_mcp_server(&server).map_err(|e| e.to_string())?;
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
        if clients
            .get(id)
            .map(|h| !h.is_finished())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    let server = state
        .repo
        .get_mcp_server(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "MCP server 不存在".to_string())?;
    let handle = mcp_client::spawn_connection(&server.server_config, &server.name,
    )?;
    state.mcp_clients.write().insert(id.to_string(), handle);
    Ok(())
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

    fn _http_server(id: &str, url: &str) -> McpServer {
        McpServer {
            id: id.into(),
            name: "test".into(),
            server_config: serde_json::json!({ "type": "http", "url": url }),
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
        let server = stdio_server("s1", "echo");
        upsert_mcp_server_with_state(&state, server).unwrap();

        assert!(!state.repo.get_mcp_server("s1").unwrap().unwrap().enabled);
        toggle_mcp_server_enabled_with_state(&state, "s1".to_string(), true)
            .await
            .unwrap();
        assert!(state.repo.get_mcp_server("s1").unwrap().unwrap().enabled);
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
}
