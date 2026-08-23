//! 上游 MCP server 的 client 连接管理（stdio + streamable-http）。

use rmcp::model::ClientInfo;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use std::collections::HashMap;
use std::time::Duration;

/// 解析 server_config JSON 并启动连接，返回保持连接的后台 task（abort 即断开）。
pub fn spawn_connection(
    server_config: &serde_json::Value,
    name: &str,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let typ = server_config
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio");
    let config = server_config.clone();
    let name = name.to_string();
    match typ {
        "http" | "sse" => {
            let url = config
                .get("url")
                .and_then(|u| u.as_str())
                .ok_or_else(|| "http 类型需要 url".to_string())?
                .to_string();
            let headers = parse_headers(config.get("headers"));
            Ok(tokio::spawn(async move {
                let transport =
                    StreamableHttpClientTransport::<reqwest::Client>::from_config(
                        StreamableHttpClientTransportConfig::with_uri(url)
                            .custom_headers(headers),
                    );
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    rmcp::service::serve_client(ClientInfo::default(), transport),
                )
                .await;
                match result {
                    Ok(Ok(running)) => {
                        log::info!("MCP {name} http connected");
                        let _ = running.waiting().await;
                    }
                    _ => log::error!("MCP {name} http connect failed"),
                }
            }))
        }
        _ => {
            let command = config
                .get("command")
                .and_then(|c| c.as_str())
                .ok_or_else(|| "stdio 类型需要 command".to_string())?
                .to_string();
            let args: Vec<String> = config
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let env_map = parse_env(config.get("env"));
            Ok(tokio::spawn(async move {
                let mut cmd = tokio::process::Command::new(command);
                cmd.args(&args);
                for (k, v) in env_map {
                    cmd.env(k, v);
                }
                let transport = match TokioChildProcess::new(cmd) {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("MCP {name} failed to spawn child process: {e}");
                        return;
                    }
                };
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    rmcp::service::serve_client(ClientInfo::default(), transport),
                )
                .await;
                match result {
                    Ok(Ok(running)) => {
                        log::info!("MCP {name} stdio connected");
                        let _ = running.waiting().await;
                    }
                    _ => log::error!("MCP {name} stdio connect failed"),
                }
            }))
        }
    }
}

/// 临时连接测试：连上立即断开，返回 ok/err。
pub async fn test_connection(server_config: &serde_json::Value) -> Result<String, String> {
    let handle = spawn_connection(server_config, "test")?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    if handle.is_finished() {
        Err("连接失败（握手未完成）".to_string())
    } else {
        handle.abort();
        Ok("连接成功".to_string())
    }
}

fn parse_headers(value: Option<&serde_json::Value>) -> HashMap<http::HeaderName, http::HeaderValue> {
    let mut headers = HashMap::new();
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return headers;
    };
    for (k, v) in obj {
        let Ok(name) = http::HeaderName::from_bytes(k.as_bytes()) else {
            log::warn!("invalid MCP http header name: {k}");
            continue;
        };
        let value_str = v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
        let Ok(value) = http::HeaderValue::from_str(&value_str) else {
            log::warn!("invalid MCP http header value: {value_str}");
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

fn parse_env(value: Option<&serde_json::Value>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let Some(obj) = value.and_then(|v| v.as_object()) else {
        return env;
    };
    for (k, v) in obj {
        if let Some(vs) = v.as_str() {
            env.insert(k.clone(), vs.to_string());
        }
    }
    env
}
