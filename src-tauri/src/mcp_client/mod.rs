//! 上游 MCP server 的 client 连接管理（stdio + streamable-http）。

use rmcp::model::ClientInfo;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use std::collections::HashMap;
use std::time::Duration;

/// 解析 server_config JSON 并启动连接。
///
/// 返回后台保活 task（abort 即断开）与一个 oneshot，后者由 task 在握手成功时发送
/// `Ok(())`、在任一失败路径（进程启动失败 / 握手超时 / serve_client 错误）发送
/// `Err(msg)`。调用方需通过 [`await_handshake`] 等待握手结果，以确定连接是否真正建立。
pub fn spawn_connection(
    server_config: &serde_json::Value,
    name: &str,
) -> Result<
    (
        tokio::task::JoinHandle<()>,
        tokio::sync::oneshot::Receiver<Result<(), String>>,
    ),
    String,
> {
    let typ = server_config
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio");
    let config = server_config.clone();
    let name = name.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = match typ {
        "http" | "sse" => {
            let url = config
                .get("url")
                .and_then(|u| u.as_str())
                .ok_or_else(|| "http 类型需要 url".to_string())?
                .to_string();
            let headers = parse_headers(config.get("headers"));
            tokio::spawn(async move {
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
                        let _ = tx.send(Ok(()));
                        let _ = running.waiting().await;
                    }
                    Ok(Err(e)) => {
                        log::error!("MCP {name} http connect failed: {e}");
                        let _ = tx.send(Err(format!("连接失败: {e}")));
                    }
                    Err(_) => {
                        log::error!("MCP {name} http connect timed out");
                        let _ = tx.send(Err("连接超时".to_string()));
                    }
                }
            })
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
            tokio::spawn(async move {
                let mut cmd = tokio::process::Command::new(command);
                cmd.args(&args);
                for (k, v) in env_map {
                    cmd.env(k, v);
                }
                let transport = match TokioChildProcess::new(cmd) {
                    Ok(t) => t,
                    Err(e) => {
                        log::error!("MCP {name} failed to spawn child process: {e}");
                        let _ = tx.send(Err(format!("启动进程失败: {e}")));
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
                        let _ = tx.send(Ok(()));
                        let _ = running.waiting().await;
                    }
                    Ok(Err(e)) => {
                        log::error!("MCP {name} stdio connect failed: {e}");
                        let _ = tx.send(Err(format!("连接失败: {e}")));
                    }
                    Err(_) => {
                        log::error!("MCP {name} stdio connect timed out");
                        let _ = tx.send(Err("连接超时".to_string()));
                    }
                }
            })
        }
    };
    Ok((handle, rx))
}

/// 等待握手结果，超时略高于内部 5s 握手预算（6s）。
///
/// 成功返回 `Ok(())`（保活 task 继续运行，由调用方负责 abort）；失败或超时则
/// abort 后台 task 并返回错误信息。
pub async fn await_handshake(
    handle: &tokio::task::JoinHandle<()>,
    rx: tokio::sync::oneshot::Receiver<Result<(), String>>,
    name: &str,
) -> Result<(), String> {
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(msg))) => {
            handle.abort();
            Err(msg)
        }
        Ok(Err(_)) => {
            // 通道被关闭且无消息：task 异常退出（如 panic/join error）前未发送结果。
            handle.abort();
            Err(format!("MCP {name} 连接失败（进程异常退出）"))
        }
        Err(_) => {
            handle.abort();
            Err(format!("MCP {name} 连接超时"))
        }
    }
}

/// 临时连接测试：以握手结果判定成败，连上立即断开。
pub async fn test_connection(server_config: &serde_json::Value) -> Result<String, String> {
    let (handle, rx) = spawn_connection(server_config, "test")?;
    match await_handshake(&handle, rx, "test").await {
        Ok(()) => {
            handle.abort();
            Ok("连接成功".to_string())
        }
        Err(msg) => Err(msg),
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
