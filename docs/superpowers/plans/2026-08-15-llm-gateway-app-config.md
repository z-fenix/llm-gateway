# 阶段 6 · 应用配置 + 导入导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「设置」能力:固定首选端口、一键把网关写入 Claude Code/Codex 配置、最小 `/v1/responses` 适配(让 Codex 可用)、全量配置导入导出(渠道 api_key 脱敏)。

**Architecture:** 后端新增 `config/`(settings 应用配置 + backup 导出 + restore 导入)、`cli_config/`(claude_code/codex 配置生成与落盘)、`protocol/responses.rs`(Responses↔统一 ChatRequest 映射)。`/v1/responses` 复用 `handlers::handle()` 整条管线(鉴权/RAG/安检/角色路由/转发/日志自动继承)。应用配置沿用 `tauri_plugin_store` 的 `store.bin`(镜像 `knowledge/settings.rs` 模式)。前端新增 `SettingsPage`。

**Tech Stack:** axum 0.8、tauri 2、tauri-plugin-store 2、serde_json(preserve_order)、新增 `toml = "0.8"`(Codex config.toml 合并)、`dirs = "6"`(home_dir)、parking_lot、reqwest;前端 React/TS + lucide-react。

**Spec:** `docs/superpowers/specs/2026-08-15-llm-gateway-app-config-design.md`

## Global Constraints

- 安全不变量不得回归:真实 `channels.api_key` 永不外泄 —— **导出文件中渠道 `api_key` 一律置 `""`**;命令层 `list_channels` 会打码,导出须直接调 `state.repo.list_channels()` 再脱敏;落库 body 仍经 `redact_json_for_logging`(本阶段不新增 body 写日志)。
- 锁:生产代码一律 parking_lot `.read()`/`.write()`/`.lock()`,无 `.unwrap()`;测试 mock 内 std Mutex 除外。
- SQL 全参数化(走 repository);不改既有表结构/迁移(仅新增代码 + store.bin 键)。
- 端口范围固定 `8777..=8787`;`preferred_port` 默认 **8779**,须钳制/校验在该区间。
- CLI 写入一律用**当前实际 bound 端口**(`state.bound_addr`),None 则报错「网关未启动」。
- 提交前缀:`feat(config):`/`feat(cli):`/`feat(responses):`/`test(...)`/`fix(...)`/`docs(...)`。
- 每任务验收:`cargo test --manifest-path src-tauri/Cargo.toml` 全绿、`cargo build` 0 新 warning;改前端 `pnpm typecheck` 通过。
- **新增 crate 以实际编译为准**:`toml`、`dirs` 首次 `cargo add` 后 `cargo build` 验证;若版本/API 有偏差以实现时真实 API 为准并在报告说明。

---

### Task 1: 依赖 + AppConfig 设置 + state 字段 + 端口/bound_addr 接线

**Files:**
- Modify: `src-tauri/Cargo.toml`(`[dependencies]` 加 `toml = "0.8"`、`dirs = "6"`)
- Create: `src-tauri/src/config/settings.rs`
- Create: `src-tauri/src/config/mod.rs`
- Modify: `src-tauri/src/proxy/state.rs`(`AppState` 加 `bound_addr`、`app` 字段)
- Modify: `src-tauri/src/lib.rs`(`pub mod config;` + 启动加载 app 配置 + 用 preferred_port 启动 + 写 bound_addr)

**Interfaces:**
- Consumes: `AppState::new(db)`、`proxy::server::start(state, start_port)`(返回 `(JoinHandle, SocketAddr)`)、store.bin。
- Produces:
  - `config::settings::AppConfig { pub preferred_port: u16 }`(Default=8779,`Serialize/Deserialize/PartialEq/Eq`)
  - `config::settings::merge_from_store(AppConfig, &serde_json::Map<String,Value>) -> AppConfig`(纯函数,可单测)
  - `config::settings::get_app_config(&tauri::AppHandle) -> AppConfig`
  - `config::settings::apply_settings(&AppState, &AppConfig)`
  - `AppState.bound_addr: Arc<RwLock<Option<std::net::SocketAddr>>>`、`AppState.app: Arc<RwLock<AppConfig>>`

- [ ] **Step 1: 加依赖并编译验证**

```bash
cd src-tauri && cargo add toml@0.8 dirs@6 && cargo build
```
预期:build 通过,0 新 warning。

- [ ] **Step 2: 失败单测(merge_from_store)**

`src-tauri/src/config/settings.rs` 内 `#[cfg(test)]`:
```rust
#[test]
fn merge_prefers_store_and_clamps_range() {
    let mut v = serde_json::Map::new();
    v.insert("app.preferred_port".into(), serde_json::json!(8780));
    assert_eq!(merge_from_store(AppConfig::default(), &v).preferred_port, 8780);
    // 超出 8777..=8787 → 回落默认 8779
    let mut bad = serde_json::Map::new();
    bad.insert("app.preferred_port".into(), serde_json::json!(9999));
    assert_eq!(merge_from_store(AppConfig::default(), &bad).preferred_port, 8779);
}
#[test]
fn merge_keeps_default_on_missing() {
    assert_eq!(merge_from_store(AppConfig::default(), &serde_json::Map::new()), AppConfig::default());
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_` → FAIL(模块不存在)。

- [ ] **Step 3: 实现 settings.rs + mod.rs + state 字段**

`src-tauri/src/config/settings.rs`:
```rust
use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

pub const MIN_PORT: u16 = 8777;
pub const MAX_PORT: u16 = 8787;

/// 应用配置:首选端口(下次启动生效)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppConfig {
    pub preferred_port: u16,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { preferred_port: 8779 }
    }
}

fn clamp_port(p: u16) -> u16 {
    if (MIN_PORT..=MAX_PORT).contains(&p) { p } else { AppConfig::default().preferred_port }
}

pub fn merge_from_store(mut c: AppConfig, values: &serde_json::Map<String, serde_json::Value>) -> AppConfig {
    if let Some(p) = values.get("app.preferred_port").and_then(|v| v.as_u64()) {
        c.preferred_port = clamp_port(p as u16);
    }
    c
}

pub fn get_app_config(app: &tauri::AppHandle) -> AppConfig {
    let mut c = AppConfig::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        if let Some(v) = store.get("app.preferred_port") {
            values.insert("app.preferred_port".to_string(), v);
        }
        c = merge_from_store(c, &values);
    }
    c
}

pub fn apply_settings(state: &crate::proxy::state::AppState, c: &AppConfig) {
    *state.app.write() = c.clone();
}
```

`src-tauri/src/config/mod.rs`:
```rust
pub mod settings;
```

`src-tauri/src/proxy/state.rs`:`AppState` 结构体加两字段,`new()` 里初始化:
```rust
use crate::config::settings::AppConfig;
use std::net::SocketAddr;
// struct 字段:
pub bound_addr: Arc<RwLock<Option<SocketAddr>>>,
/// 应用配置(首选端口等)
pub app: Arc<RwLock<AppConfig>>,
// new() 初始化:
bound_addr: Arc::new(RwLock::new(None)),
app: Arc::new(RwLock::new(AppConfig::default())),
```

- [ ] **Step 4: lib.rs 接线**

`lib.rs` 顶部加 `pub mod config;`。setup 内(加载 RAG 设置之后)加:
```rust
// 从 tauri-plugin-store 加载应用配置(首选端口)并同步到 AppState
let appcfg = config::settings::get_app_config(&app.handle());
config::settings::apply_settings(&state, &appcfg);
```
网关启动线程改为用 preferred_port 并回写 bound_addr:
```rust
std::thread::spawn(move || {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async move {
        let start_port = state.app.read().preferred_port;
        match proxy::server::start(state.clone(), start_port).await {
            Ok((handle, addr)) => {
                *state.bound_addr.write() = Some(addr);
                handle.await.expect("serve gateway");
            }
            Err(e) => {
                log::error!("no available port in {}..=8787: {}", start_port, e);
            }
        }
    });
});
```

- [ ] **Step 5: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_` → PASS;`cargo build` 0 新 warning;全量 `cargo test` 不回归。
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/config/ src-tauri/src/proxy/state.rs src-tauri/src/lib.rs
git commit -m "feat(config): AppConfig 首选端口 + bound_addr 接线 + toml/dirs 依赖"
```

---

### Task 2: `/v1/responses` 非流式适配(request_to_chat + chat_to_response + 路由)

**Files:**
- Create: `src-tauri/src/protocol/responses.rs`
- Modify: `src-tauri/src/protocol/mod.rs`(加 `pub mod responses;`)
- Modify: `src-tauri/src/proxy/handlers.rs`(`Protocol` 加 `Responses`、`responses_messages` handler、`handle()` 解析与响应分支、protocol 字符串 arm)
- Modify: `src-tauri/src/proxy/server.rs`(route 加 `/v1/responses`)

**Interfaces:**
- Consumes: `protocol::types::{ChatMessage, ChatRequest, ChatResponse}`、`handlers::handle(state, headers, body, Protocol)` 既有管线。
- Produces:
  - `protocol::responses::request_to_chat(&serde_json::Value) -> Result<ChatRequest, String>`
  - `protocol::responses::chat_to_response(&ChatResponse) -> serde_json::Value`
  - 路由 `POST /v1/responses` → `handlers::responses_messages`;`Protocol::Responses` 的 protocol 字符串为 `"responses"`。

- [ ] **Step 1: 失败单测(纯映射)**

`src-tauri/src/protocol/responses.rs` 内 `#[cfg(test)]`:
```rust
#[test]
fn responses_req_maps_instructions_and_input_string() {
    let v = serde_json::json!({"model":"gpt-x","instructions":"you are helpful","input":"hi","max_output_tokens":64,"stream":false});
    let chat = request_to_chat(&v).unwrap();
    assert_eq!(chat.model, "gpt-x");
    assert_eq!(chat.messages[0].role, "system");
    assert_eq!(chat.messages[1].role, "user");
    assert_eq!(chat.max_tokens, Some(64));
    assert!(!chat.stream);
}
#[test]
fn responses_req_maps_input_array_and_function_tools() {
    let v = serde_json::json!({"model":"m","input":[
        {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}
    ],"tools":[{"type":"function","name":"f","description":"d","parameters":{}}]});
    let chat = request_to_chat(&v).unwrap();
    assert_eq!(chat.messages.len(), 1);
    assert_eq!(chat.messages[0].content, serde_json::json!("hello"));
    let tools = chat.tools.unwrap();
    assert_eq!(tools[0]["function"]["name"], serde_json::json!("f"));
}
#[test]
fn responses_resp_shape() {
    let chat = crate::protocol::types::ChatResponse {
        id: "x".into(), model: "m".into(), content: serde_json::json!("answer"),
        stop_reason: Some("stop".into()), input_tokens: 3, output_tokens: 5, raw: serde_json::json!({}),
    };
    let out = chat_to_response(&chat);
    assert_eq!(out["object"], serde_json::json!("response"));
    assert_eq!(out["output"][0]["content"][0]["text"], serde_json::json!("answer"));
    assert_eq!(out["usage"]["total_tokens"], serde_json::json!(8));
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml responses_` → FAIL(模块不存在)。

- [ ] **Step 2: 实现 responses.rs 纯映射**

`src-tauri/src/protocol/responses.rs`:
```rust
use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// Responses /v1/responses 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages: Vec<ChatMessage> = Vec::new();
    if let Some(instr) = v.get("instructions").and_then(|s| s.as_str()) {
        messages.push(ChatMessage {
            role: "system".into(),
            content: serde_json::Value::String(instr.to_string()),
        });
    }
    match v.get("input") {
        Some(serde_json::Value::String(s)) => {
            messages.push(ChatMessage {
                role: "user".into(),
                content: serde_json::Value::String(s.clone()),
            });
        }
        Some(serde_json::Value::Array(items)) => {
            for it in items {
                let role = it.get("role").and_then(|r| r.as_str());
                let is_msg = it.get("type").and_then(|t| t.as_str()) == Some("message") || role.is_some();
                if !is_msg {
                    continue;
                }
                let mut text = String::new();
                if let Some(parts) = it.get("content").and_then(|c| c.as_array()) {
                    for p in parts {
                        if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                        }
                    }
                } else if let Some(c) = it.get("content").and_then(|c| c.as_str()) {
                    text = c.to_string();
                }
                messages.push(ChatMessage {
                    role: role.unwrap_or("user").to_string(),
                    content: serde_json::Value::String(text),
                });
            }
        }
        _ => {}
    }
    // 仅映射 function 工具为 chat tools,其余类型忽略(最小适配)
    let tools = v
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    if t.get("type").and_then(|x| x.as_str()) == Some("function") {
                        Some(serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": t.get("name").cloned().unwrap_or(serde_json::Value::Null),
                                "description": t.get("description").cloned().unwrap_or(serde_json::Value::Null),
                                "parameters": t.get("parameters").cloned().unwrap_or(serde_json::json!({})),
                            }
                        }))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<serde_json::Value>| !v.is_empty())
        .map(serde_json::Value::Array);
    Ok(ChatRequest {
        model,
        messages,
        max_tokens: v.get("max_output_tokens").and_then(|t| t.as_u64()).map(|t| t as u32),
        stream: v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false),
        temperature: v.get("temperature").and_then(|t| t.as_f64()).map(|t| t as f32),
        tools,
        extra: Default::default(),
    })
}

/// 提取 ChatResponse 文本(content 可能是 string 或其它 JSON)。
pub fn response_text(chat: &ChatResponse) -> String {
    match &chat.content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 统一 ChatResponse → Responses 响应壳(非流式)。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    let text = response_text(chat);
    serde_json::json!({
        "id": format!("resp_{}", uuid::Uuid::new_v4()),
        "object": "response",
        "status": "completed",
        "model": chat.model,
        "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": text }]
        }],
        "usage": {
            "input_tokens": chat.input_tokens,
            "output_tokens": chat.output_tokens,
            "total_tokens": chat.input_tokens + chat.output_tokens
        }
    })
}
```

`src-tauri/src/protocol/mod.rs`:加 `pub mod responses;`。

- [ ] **Step 3: handlers.rs 接 Protocol::Responses(非流式)+ 路由**

`handlers.rs` 改动:
1. `use crate::protocol::{anthropic, openai, responses, types::ChatRequest};`(加 `responses`)。
2. `Protocol` 枚举加 `Responses`。
3. 新 handler:
```rust
pub async fn responses_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    handle(state, headers, body, Protocol::Responses).await
}
```
4. `handle()` 解析处加 arm:
```rust
Protocol::Responses => match responses::request_to_chat(&body) {
    Ok(c) => c,
    Err(e) => {
        return log_failure(&state, &trace_id, Some(&api_key), proto, StatusCode::BAD_REQUEST, &e, None, &body)
    }
},
```
5. `handle()` 里 `let request_model = chat.model.clone();` 之后,**Responses 强制走非流式转发**(流式由 Task 3 合成),并记录客户端是否请求流式:
```rust
// Responses:内部统一非流式转发,流式由响应侧合成(Task 3)
let client_wants_stream = chat.stream;
if proto == Protocol::Responses {
    chat.stream = false;
}
```
6. `proto_str`(security_hook 用)与 `write_log`/日志里的 `match proto` 各加 `Protocol::Responses => "responses"`。
7. 非流式成功分支的 `resp_body` 两处 `match proto`(Redact 与 Allow)各加:
```rust
Protocol::Responses => responses::chat_to_response(&to_chat_response(<对应 outcome>, &request_model)),
```
(Redact 分支用 `&redacted_outcome`,Allow 分支用 `o`。本任务先返回 JSON;`client_wants_stream` 暂存,Task 3 用。)

`server.rs` router 加:
```rust
.route("/v1/responses", post(handlers::responses_messages))
```

- [ ] **Step 4: 测试通过 + e2e 冒烟 + 提交**

单测 PASS 后,补一个真实网关 e2e(可放 `src-tauri/tests/`,复用 `tests/common` 或 kb_rag 的内存 DB + mock 上游模式):POST `/v1/responses` 带有效 key + mock 上游 → 断言返回 `object=="response"` 且 `output[0].content[0].text` 非空、`usage.total_tokens` 为数值。
Run: `cargo test --manifest-path src-tauri/Cargo.toml responses_` → PASS;e2e → PASS;`cargo build` 0 新 warning;全量不回归。
```bash
git add src-tauri/src/protocol/ src-tauri/src/proxy/ src-tauri/tests/
git commit -m "feat(responses): /v1/responses 非流式适配(复用统一管线)"
```

---

### Task 3: `/v1/responses` 流式 SSE 合成

**Files:**
- Modify: `src-tauri/src/protocol/responses.rs`(加 `chat_to_sse_events(&ChatResponse) -> String` + 单测)
- Modify: `src-tauri/src/proxy/handlers.rs`(Allow 分支:Responses 且 `client_wants_stream` 时返回 SSE)

**Interfaces:**
- Consumes: Task 2 的 `chat_to_response`/`response_text`、`handle()` 里的 `client_wants_stream`、`to_chat_response`。
- Produces:
  - `protocol::responses::chat_to_sse_events(&ChatResponse) -> String`(完整 SSE 文本,`\n\n` 分隔事件)
  - `POST /v1/responses` 带 `"stream":true` → `content-type: text/event-stream`,事件序列含 `response.created`…`response.completed`。

- [ ] **Step 1: 失败单测(SSE 事件序列)**

`responses.rs` 内:
```rust
#[test]
fn responses_sse_event_sequence() {
    let chat = crate::protocol::types::ChatResponse {
        id: "x".into(), model: "m".into(), content: serde_json::json!("hello world"),
        stop_reason: Some("stop".into()), input_tokens: 1, output_tokens: 2, raw: serde_json::json!({}),
    };
    let sse = chat_to_sse_events(&chat);
    let order = ["response.created", "response.output_item.added", "response.content_part.added",
        "response.output_text.delta", "response.output_text.done", "response.content_part.done",
        "response.output_item.done", "response.completed"];
    let mut last = 0usize;
    for ev in order {
        let pos = sse.find(ev).unwrap_or_else(|| panic!("missing event {ev}"));
        assert!(pos >= last, "event {ev} out of order");
        last = pos;
    }
    assert!(sse.contains("\"delta\":\"hello world\""));
    assert!(sse.contains("text/event-stream") == false); // 仅事件文本,不含 content-type
    assert!(sse.contains("\"total_tokens\":3"));
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml responses_sse` → FAIL。

- [ ] **Step 2: 实现 chat_to_sse_events**

`responses.rs`:
```rust
/// 统一 ChatResponse → Responses 流式 SSE 文本(整段文本作为单个 delta,终态事件序列)。
pub fn chat_to_sse_events(chat: &ChatResponse) -> String {
    let text = response_text(chat);
    let resp_id = format!("resp_{}", uuid::Uuid::new_v4());
    let base = serde_json::json!({
        "id": resp_id, "object": "response", "status": "in_progress", "model": chat.model,
    });
    let completed = serde_json::json!({
        "id": resp_id, "object": "response", "status": "completed", "model": chat.model,
        "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": text }]
        }],
        "usage": {
            "input_tokens": chat.input_tokens,
            "output_tokens": chat.output_tokens,
            "total_tokens": chat.input_tokens + chat.output_tokens
        }
    });
    let item = serde_json::json!({"type":"message","role":"assistant","status":"in_progress","content":[]});
    let part_empty = serde_json::json!({"type":"output_text","text":""});
    let events = vec![
        ("response.created", serde_json::json!({"type":"response.created","response":base})),
        ("response.output_item.added", serde_json::json!({"type":"response.output_item.added","output_index":0,"item":item})),
        ("response.content_part.added", serde_json::json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":part_empty})),
        ("response.output_text.delta", serde_json::json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":text})),
        ("response.output_text.done", serde_json::json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":text})),
        ("response.content_part.done", serde_json::json!({"type":"response.content_part.done","output_index":0,"content_index":0,"part":serde_json::json!({"type":"output_text","text":text})})),
        ("response.output_item.done", serde_json::json!({"type":"response.output_item.done","output_index":0,"item":serde_json::json!({"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text}]})})),
        ("response.completed", serde_json::json!({"type":"response.completed","response":completed})),
    ];
    let mut out = String::new();
    for (name, data) in events {
        out.push_str(&format!("event: {}\ndata: {}\n\n", name, data));
    }
    out
}
```

- [ ] **Step 3: handlers.rs Allow 分支返回 SSE**

`handle()` 非流式成功分支,Allow(`_ =>`)arm 当前是:
```rust
_ => {
    let resp_body = match proto { ... };
    (StatusCode::OK, Json(resp_body)).into_response()
}
```
改为(在算出 `resp_body` 后):
```rust
_ => {
    if proto == Protocol::Responses && client_wants_stream {
        let sse = responses::chat_to_sse_events(&to_chat_response(o, &request_model));
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            sse,
        )
            .into_response();
    }
    let resp_body = match proto { /* 含 Responses arm */ };
    (StatusCode::OK, Json(resp_body)).into_response()
}
```
(Redact 分支 Responses 仍返回 JSON——redact+stream 组合属边缘,最小适配不合成;文档注明。)

- [ ] **Step 4: e2e 流式断言 + 提交**

e2e:POST `/v1/responses` `"stream":true` → 断言 `content-type` 含 `text/event-stream`,body 依次含 `response.created` 与 `response.completed`。
Run: `cargo test --manifest-path src-tauri/Cargo.toml responses_` → PASS;e2e → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/protocol/responses.rs src-tauri/src/proxy/handlers.rs src-tauri/tests/
git commit -m "feat(responses): /v1/responses 流式 SSE 合成(终态事件序列)"
```

---

### Task 4: cli_config Claude Code 一键写入

**Files:**
- Create: `src-tauri/src/cli_config/mod.rs`
- Create: `src-tauri/src/cli_config/claude_code.rs`
- Modify: `src-tauri/src/lib.rs`(`pub mod cli_config;`)

**Interfaces:**
- Consumes: Task 1 `state.bound_addr`;`state.repo.list_api_keys()`(含真实 `key`,按 id 找)。
- Produces:
  - `cli_config::CliWriteResult { pub path: String, pub changed_keys: Vec<String>, pub backup_path: Option<String>, pub env_instructions: Option<String> }`(`Serialize`)
  - `cli_config::backup_and_write(path: &Path, content: &str) -> Result<Option<String>, String>`(写前备份 `<file>.bak`)
  - `cli_config::claude_code::settings_path(home: &Path) -> PathBuf`、`dotclaude_path(home: &Path) -> PathBuf`
  - `claude_code::merge_settings(existing: Option<&str>, base_url: &str, token: &str) -> Result<(String, Vec<String>), String>`(纯函数)
  - `claude_code::merge_dotclaude(existing: Option<&str>) -> Result<(String, Vec<String>), String>`(纯函数,确保 `hasCompletedOnboarding:true`)
  - `claude_code::write(home: &Path, base_url: &str, token: &str) -> Result<Vec<CliWriteResult>, String>`(写 settings.json + .claude.json)

- [ ] **Step 1: 失败单测(纯合并函数)**

`claude_code.rs` 内 `#[cfg(test)]`:
```rust
#[test]
fn merge_settings_preserves_unrelated_and_sets_env() {
    let existing = r#"{ "model": "opus", "env": { "OTHER": "1" } }"#;
    let (out, changed) = merge_settings(Some(existing), "http://127.0.0.1:8779", "sk-lgw-abc").unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["model"], serde_json::json!("opus"));           // 无关键保留
    assert_eq!(v["env"]["OTHER"], serde_json::json!("1"));         // env 无关键保留
    assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], serde_json::json!("http://127.0.0.1:8779"));
    assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], serde_json::json!("sk-lgw-abc"));
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
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_` → FAIL。

- [ ] **Step 2: 实现 mod.rs(backup_and_write + CliWriteResult)**

`src-tauri/src/cli_config/mod.rs`:
```rust
pub mod claude_code;

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct CliWriteResult {
    pub path: String,
    pub changed_keys: Vec<String>,
    pub backup_path: Option<String>,
    pub env_instructions: Option<String>,
}

/// 写文件前备份已存在文件为 `<文件名>.bak`,返回备份路径。
pub fn backup_and_write(path: &Path, content: &str) -> Result<Option<String>, String> {
    let backup_path = if path.exists() {
        let fname = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "invalid file name".to_string())?;
        let bak = path.with_file_name(format!("{}.bak", fname));
        std::fs::copy(path, &bak).map_err(|e| format!("backup {}: {}", bak.display(), e))?;
        Some(bak.display().to_string())
    } else {
        None
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(backup_path)
}
```

- [ ] **Step 3: 实现 claude_code.rs**

```rust
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
            let v: serde_json::Value = serde_json::from_str(s).map_err(|e| format!("parse json: {e}"))?;
            Ok(if v.is_object() { v } else { serde_json::json!({}) })
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
    let env = root_obj.entry("env").or_insert_with(|| serde_json::json!({}));
    if !env.is_object() {
        *env = serde_json::json!({});
    }
    let env = env.as_object_mut().unwrap();
    let mut changed = vec![];
    for (k, val) in [("ANTHROPIC_BASE_URL", base_url), ("ANTHROPIC_AUTH_TOKEN", token)] {
        if env.get(k).and_then(|v| v.as_str()) != Some(val) {
            env.insert(k.to_string(), serde_json::Value::String(val.to_string()));
            changed.push(format!("env.{k}"));
        }
    }
    Ok((serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?, changed))
}

/// 确保 .claude.json hasCompletedOnboarding=true(否则 CC 强制登录页忽略 env)。
pub fn merge_dotclaude(existing: Option<&str>) -> Result<(String, Vec<String>), String> {
    let mut root = load_root(existing)?;
    let obj = root.as_object_mut().unwrap();
    let mut changed = vec![];
    if obj.get("hasCompletedOnboarding").and_then(|v| v.as_bool()) != Some(true) {
        obj.insert("hasCompletedOnboarding".to_string(), serde_json::Value::Bool(true));
        changed.push("hasCompletedOnboarding".to_string());
    }
    Ok((serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?, changed))
}

fn read_opt(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// 写 settings.json + .claude.json,各返回一个 CliWriteResult。
pub fn write(home: &Path, base_url: &str, token: &str) -> Result<Vec<CliWriteResult>, String> {
    let sp = settings_path(home);
    let (content, changed) = merge_settings(read_opt(&sp).as_deref(), base_url, token)?;
    let backup = backup_and_write(&sp, &content)?;
    let mut out = vec![CliWriteResult {
        path: sp.display().to_string(),
        changed_keys: changed,
        backup_path: backup,
        env_instructions: None,
    }];
    let dp = dotclaude_path(home);
    let (dcontent, dchanged) = merge_dotclaude(read_opt(&dp).as_deref())?;
    let dbackup = backup_and_write(&dp, &dcontent)?;
    out.push(CliWriteResult {
        path: dp.display().to_string(),
        changed_keys: dchanged,
        backup_path: dbackup,
        env_instructions: None,
    });
    Ok(out)
}
```

`lib.rs` 加 `pub mod cli_config;`。

- [ ] **Step 4: 落盘测试(temp home)+ 提交**

`claude_code.rs` 测试追加(用 `tempfile::tempdir()`):
```rust
#[test]
fn write_creates_files_and_backup() {
    let home = tempfile::tempdir().unwrap();
    // 先写一次(无备份),再写一次(有备份)
    let r1 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-a").unwrap();
    assert!(settings_path(home.path()).exists());
    assert!(r1[0].backup_path.is_none());
    let r2 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-b").unwrap();
    assert!(r2[0].backup_path.is_some());
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], serde_json::json!("sk-lgw-b"));
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_ write_` → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/cli_config/ src-tauri/src/lib.rs
git commit -m "feat(cli): Claude Code 一键写入(settings.json + .claude.json,深合并+备份)"
```

---

### Task 5: cli_config Codex 一键写入(config.toml + env)

**Files:**
- Create: `src-tauri/src/cli_config/codex.rs`
- Modify: `src-tauri/src/cli_config/mod.rs`(加 `pub mod codex;`)

**Interfaces:**
- Consumes: Task 4 `backup_and_write`/`CliWriteResult`;`toml` crate。
- Produces:
  - `codex::config_path(home: &Path) -> PathBuf`
  - `codex::merge_config(existing: Option<&str>, base_url: &str) -> Result<(String, Vec<String>), String>`(纯函数,设 `model_provider="llm-gateway"` + `[model_providers.llm-gateway]` 表,保留其它键/provider)
  - `codex::env_instructions(token: &str) -> String`(按平台给 setx / export 文本)
  - `codex::write_env_var(home: &Path, token: &str) -> Result<(), String>`(Windows `setx`;unix 追加/替换 `~/.profile` 的 `export LLM_GATEWAY_KEY=...`)
  - `codex::write(home: &Path, base_url: &str, token: &str, write_env: bool) -> Result<CliWriteResult, String>`

- [ ] **Step 1: 失败单测(toml 合并)**

`codex.rs` 内 `#[cfg(test)]`:
```rust
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
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_config` → FAIL。

- [ ] **Step 2: 实现 codex.rs**

```rust
use super::{backup_and_write, CliWriteResult};
use std::path::{Path, PathBuf};

pub const ENV_KEY: &str = "LLM_GATEWAY_KEY";
pub const PROVIDER: &str = "llm-gateway";

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}

/// 合并 config.toml,设 model_provider 与 [model_providers.llm-gateway],保留其它键/provider。
pub fn merge_config(existing: Option<&str>, base_url: &str) -> Result<(String, Vec<String>), String> {
    let mut doc: toml::Value = match existing {
        Some(s) if !s.trim().is_empty() => toml::from_str(s).map_err(|e| format!("parse config.toml: {e}"))?,
        _ => toml::Value::Table(toml::map::Map::new()),
    };
    let root = doc.as_table_mut().ok_or_else(|| "config.toml root not a table".to_string())?;
    let mut changed = vec![];

    if root.get("model_provider").and_then(|v| v.as_str()) != Some(PROVIDER) {
        root.insert("model_provider".into(), toml::Value::String(PROVIDER.into()));
        changed.push("model_provider".into());
    }
    let providers = root
        .entry("model_providers".into())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !providers.is_table() {
        *providers = toml::Value::Table(toml::map::Map::new());
    }
    let providers = providers.as_table_mut().unwrap();
    let block = providers
        .entry(PROVIDER.into())
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
            block.insert(k.into(), val);
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

/// 写用户级环境变量。Windows 用 setx;unix 追加/替换 ~/.profile 的 export 行。
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
        let existing = std::fs::read_to_string(&profile).unwrap_or_default();
        let line = format!("export {ENV_KEY}=\"{token}\"");
        let mut kept: Vec<String> = existing
            .lines()
            .filter(|l| !l.trim_start().starts_with(&format!("export {ENV_KEY}=")))
            .map(|l| l.to_string())
            .collect();
        kept.push(line);
        std::fs::write(&profile, kept.join("\n") + "\n")
            .map_err(|e| format!("write {}: {e}", profile.display()))
    }
}

pub fn write(home: &Path, base_url: &str, token: &str, write_env: bool) -> Result<CliWriteResult, String> {
    let cp = config_path(home);
    let existing = std::fs::read_to_string(&cp).ok();
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
```

`mod.rs` 加 `pub mod codex;`。

- [ ] **Step 3: 测试通过 + 提交**

追加落盘测试(temp home,`write(..., write_env=false)` 断言 `env_instructions` 为 Some 且 config.toml 写入)。Run: `cargo test --manifest-path src-tauri/Cargo.toml merge_config` → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/cli_config/
git commit -m "feat(cli): Codex 一键写入(config.toml provider + 可选 env 写入)"
```

---

### Task 6: config 导出(backup.rs,渠道脱敏)+ export 命令

**Files:**
- Create: `src-tauri/src/config/backup.rs`
- Modify: `src-tauri/src/config/mod.rs`(加 `pub mod backup;`)
- Create: `src-tauri/src/commands/config.rs`(本任务只放 `export_config` + `default_export_path`;后续任务并入)
- Modify: `src-tauri/src/commands/mod.rs`(加 `pub mod config;`)
- Modify: `src-tauri/src/lib.rs`(注册命令)

**Interfaces:**
- Consumes: `state.repo.list_channels()/list_api_keys()/list_role_routes()/list_role_patterns()/list_builtin_rules()/list_custom_rules()`、`state.fallback`、`state.security`、`state.app`。
- Produces:
  - `config::backup::ConfigBundle`(`Serialize/Deserialize`,字段见下)
  - `config::backup::build_bundle(state: &AppState) -> Result<ConfigBundle, String>`(渠道 `api_key` 置 `""`)
  - `config::backup::export_to_file(state: &AppState, path: &Path) -> Result<u64, String>`(返回字节数)
  - 命令 `export_config(state, path: String) -> Result<u64, String>`、`default_export_path() -> String`

- [ ] **Step 1: 失败测试(脱敏 + 结构)**

`backup.rs` 内 `#[cfg(test)]`(内存 DB 造 channel/api_key/role_route,复用 knowledge 单测的内存 DB 模式):
```rust
#[test]
fn export_redacts_channel_api_key() {
    let state = test_state(); // 内存 DB;插入一条 channel(api_key="sk-real-secret")
    let bundle = build_bundle(&state).unwrap();
    assert_eq!(bundle.format, "llm-gateway-config");
    assert_eq!(bundle.version, 1);
    assert_eq!(bundle.channels.len(), 1);
    assert_eq!(bundle.channels[0].api_key, "");              // 脱敏
    let json = serde_json::to_string(&bundle).unwrap();
    assert!(!json.contains("sk-real-secret"));               // 全文无真实 key
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml export_redacts` → FAIL。

- [ ] **Step 2: 实现 backup.rs**

```rust
use crate::db::models::{ApiKey, BuiltinRule, Channel, CustomRule, RolePattern, RoleRoute};
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FORMAT: &str = "llm-gateway-config";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityExport {
    pub settings: crate::security::SecuritySettings,
    #[serde(default)] pub builtin_rules: Vec<BuiltinRule>,
    #[serde(default)] pub custom_rules: Vec<CustomRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FallbackExport {
    pub channel_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfigExport {
    pub preferred_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigBundle {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    #[serde(default)] pub app_config: Option<AppConfigExport>,
    #[serde(default)] pub channels: Vec<Channel>,
    #[serde(default)] pub api_keys: Vec<ApiKey>,
    #[serde(default)] pub role_routes: Vec<RoleRoute>,
    #[serde(default)] pub role_patterns: Vec<RolePattern>,
    #[serde(default)] pub fallback: Option<FallbackExport>,
    #[serde(default)] pub security: Option<SecurityExport>,
}

/// 汇总导出数据。安全不变量:渠道 api_key 一律置 "",绝不外泄。
pub fn build_bundle(state: &AppState) -> Result<ConfigBundle, String> {
    let mut channels = state.repo.list_channels().map_err(|e| e.to_string())?;
    for c in &mut channels {
        c.api_key = String::new(); // 脱敏
    }
    let api_keys = state.repo.list_api_keys().map_err(|e| e.to_string())?;
    let role_routes = state.repo.list_role_routes().map_err(|e| e.to_string())?;
    let role_patterns = state.repo.list_role_patterns().map_err(|e| e.to_string())?;
    let builtin_rules = state.repo.list_builtin_rules().map_err(|e| e.to_string())?;
    let custom_rules = state.repo.list_custom_rules().map_err(|e| e.to_string())?;
    let fallback = state.fallback.read().clone().map(|(channel_id, model)| FallbackExport { channel_id, model });
    let settings = state.security.read().clone();
    let app_config = Some(AppConfigExport { preferred_port: state.app.read().preferred_port });
    Ok(ConfigBundle {
        format: FORMAT.to_string(),
        version: VERSION,
        exported_at: chrono::Utc::now().timestamp(),
        app_config,
        channels,
        api_keys,
        role_routes,
        role_patterns,
        fallback,
        security: Some(SecurityExport { settings, builtin_rules, custom_rules }),
    })
}

pub fn export_to_file(state: &AppState, path: &Path) -> Result<u64, String> {
    let bundle = build_bundle(state)?;
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
    }
    std::fs::write(path, &json).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(json.len() as u64)
}
```

`config/mod.rs` 加 `pub mod backup;`。

- [ ] **Step 3: 命令 + 注册**

`src-tauri/src/commands/config.rs`:
```rust
use crate::config::backup;
use crate::proxy::state::AppState;
use std::path::PathBuf;
use tauri::State;

#[tauri::command]
pub fn export_config(state: State<AppState>, path: String) -> Result<u64, String> {
    backup::export_to_file(&state, &PathBuf::from(path))
}

#[tauri::command]
pub fn default_export_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("llm-gateway-config.json").display().to_string()
}
```
`commands/mod.rs` 加 `pub mod config;`;`lib.rs` `generate_handler!` 加 `commands::config::export_config, commands::config::default_export_path,`。

> 注:若 `crate::security::SecuritySettings` 未 derive `Deserialize`,给它补上(`Serialize` 已有,因 `get_security_settings` 返回它)。实现时验证。

- [ ] **Step 4: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml export_redacts` → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/config/ src-tauri/src/commands/ src-tauri/src/lib.rs
git commit -m "feat(config): 配置导出(带版本 JSON,渠道 api_key 脱敏)"
```

---

### Task 7: config 导入(restore.rs:preview + skip/overwrite)+ 命令

**Files:**
- Create: `src-tauri/src/config/restore.rs`
- Modify: `src-tauri/src/config/mod.rs`(加 `pub mod restore;`)
- Modify: `src-tauri/src/commands/config.rs`(加 `preview_import`、`import_config`)
- Modify: `src-tauri/src/lib.rs`(注册两命令)

**Interfaces:**
- Consumes: Task 6 `ConfigBundle`;repository 写方法(`insert_channel`/`update_channel`/`insert_api_key`/`delete_api_key`/`set_role_route`/`get_role_route`/`upsert_role_pattern`/`create_custom_rule`/`delete_custom_rule`/`update_builtin_rule`)+ list 方法;`state.fallback`/`state.security`/`state.app`。
- Produces:
  - `restore::ImportPreview { channels, api_keys, role_routes, role_patterns, custom_rules, conflicts: usize }`(`Serialize`)
  - `restore::ImportResult { imported, skipped, overwritten: usize }`(`Serialize`)
  - `restore::parse_bundle(path: &Path) -> Result<ConfigBundle, String>`(校验 format/version)
  - `restore::preview(state: &AppState, bundle: &ConfigBundle) -> ImportPreview`
  - `restore::import(state: &AppState, bundle: &ConfigBundle, strategy: &str) -> Result<ImportResult, String>`(strategy `"skip"|"overwrite"`)
  - 命令 `preview_import(state, path) -> Result<ImportPreview,String>`、`import_config(state, path, strategy) -> Result<ImportResult,String>`

**冲突键**:channels/api_keys/role_patterns/custom_rules 按 `id`;role_routes 按 `role`。

- [ ] **Step 1: 失败测试(preview 冲突 + skip/overwrite + 回环)**

`restore.rs` 内 `#[cfg(test)]`(内存 DB):
```rust
#[test]
fn preview_counts_conflicts() {
    let state = test_state_with_channel("c1"); // 已存在 id="c1"
    let bundle = bundle_with_channel("c1");    // 导入也含 id="c1"
    let p = preview(&state, &bundle);
    assert_eq!(p.channels, 1);
    assert_eq!(p.conflicts, 1);
}
#[test]
fn import_skip_keeps_existing_overwrite_replaces() {
    let state = test_state_with_channel_named("c1", "old");
    let bundle = bundle_with_channel_named("c1", "new");
    // skip:保留 old
    let r = import(&state, &bundle, "skip").unwrap();
    assert_eq!(r.skipped, 1);
    assert_eq!(state.repo.get_channel("c1").unwrap().unwrap().name, "old");
    // overwrite:覆盖为 new
    let r2 = import(&state, &bundle, "overwrite").unwrap();
    assert_eq!(r2.overwritten, 1);
    assert_eq!(state.repo.get_channel("c1").unwrap().unwrap().name, "new");
}
#[test]
fn parse_bundle_rejects_bad_version() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("bad.json");
    std::fs::write(&p, r#"{"format":"llm-gateway-config","version":99}"#).unwrap();
    assert!(parse_bundle(&p).is_err());
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml import_ preview_ parse_bundle` → FAIL。

- [ ] **Step 2: 实现 restore.rs**

```rust
use super::backup::{ConfigBundle, FORMAT, VERSION};
use crate::proxy::state::AppState;
use serde::Serialize;
use std::path::Path;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub channels: usize,
    pub api_keys: usize,
    pub role_routes: usize,
    pub role_patterns: usize,
    pub custom_rules: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub overwritten: usize,
}

pub fn parse_bundle(path: &Path) -> Result<ConfigBundle, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let b: ConfigBundle = serde_json::from_str(&text).map_err(|e| format!("parse config json: {e}"))?;
    if b.format != FORMAT {
        return Err("非 llm-gateway 配置文件".into());
    }
    if b.version != VERSION {
        return Err(format!("不支持的配置版本 {}", b.version));
    }
    Ok(b)
}

fn existing_ids(state: &AppState) -> (HashSet<String>, HashSet<String>, HashSet<String>, HashSet<String>, HashSet<String>) {
    let ch = state.repo.list_channels().map(|v| v.into_iter().map(|c| c.id).collect()).unwrap_or_default();
    let ak = state.repo.list_api_keys().map(|v| v.into_iter().map(|k| k.id).collect()).unwrap_or_default();
    let rr = state.repo.list_role_routes().map(|v| v.into_iter().map(|r| r.role).collect()).unwrap_or_default();
    let rp = state.repo.list_role_patterns().map(|v| v.into_iter().map(|p| p.id).collect()).unwrap_or_default();
    let cr = state.repo.list_custom_rules().map(|v| v.into_iter().map(|r| r.id).collect()).unwrap_or_default();
    (ch, ak, rr, rp, cr)
}

pub fn preview(state: &AppState, bundle: &ConfigBundle) -> ImportPreview {
    let (ch, ak, rr, rp, cr) = existing_ids(state);
    let mut conflicts = 0;
    conflicts += bundle.channels.iter().filter(|c| ch.contains(&c.id)).count();
    conflicts += bundle.api_keys.iter().filter(|k| ak.contains(&k.id)).count();
    conflicts += bundle.role_routes.iter().filter(|r| rr.contains(&r.role)).count();
    conflicts += bundle.role_patterns.iter().filter(|p| rp.contains(&p.id)).count();
    let n_cr = bundle.security.as_ref().map(|s| s.custom_rules.iter().filter(|r| cr.contains(&r.id)).count()).unwrap_or(0);
    conflicts += n_cr;
    ImportPreview {
        channels: bundle.channels.len(),
        api_keys: bundle.api_keys.len(),
        role_routes: bundle.role_routes.len(),
        role_patterns: bundle.role_patterns.len(),
        custom_rules: bundle.security.as_ref().map(|s| s.custom_rules.len()).unwrap_or(0),
        conflicts,
    }
}

pub fn import(state: &AppState, bundle: &ConfigBundle, strategy: &str) -> Result<ImportResult, String> {
    let overwrite = strategy == "overwrite";
    let (ch, ak, rr, rp, cr) = existing_ids(state);
    let mut res = ImportResult { imported: 0, skipped: 0, overwritten: 0 };

    for c in &bundle.channels {
        if ch.contains(&c.id) {
            if overwrite {
                state.repo.update_channel(c).map_err(|e| e.to_string())?;
                res.overwritten += 1;
            } else {
                res.skipped += 1;
            }
        } else {
            state.repo.insert_channel(c).map_err(|e| e.to_string())?;
            res.imported += 1;
        }
    }
    for k in &bundle.api_keys {
        if ak.contains(&k.id) {
            if overwrite {
                state.repo.delete_api_key(&k.id).map_err(|e| e.to_string())?;
                state.repo.insert_api_key(k).map_err(|e| e.to_string())?;
                res.overwritten += 1;
            } else {
                res.skipped += 1;
            }
        } else {
            state.repo.insert_api_key(k).map_err(|e| e.to_string())?;
            res.imported += 1;
        }
    }
    for r in &bundle.role_routes {
        if rr.contains(&r.role) && !overwrite {
            res.skipped += 1;
        } else {
            state.repo.set_role_route(&r.role, &r.channel_id, &r.target_model).map_err(|e| e.to_string())?;
            if rr.contains(&r.role) { res.overwritten += 1; } else { res.imported += 1; }
        }
    }
    for p in &bundle.role_patterns {
        if rp.contains(&p.id) && !overwrite {
            res.skipped += 1;
        } else {
            state.repo.upsert_role_pattern(p).map_err(|e| e.to_string())?;
            if rp.contains(&p.id) { res.overwritten += 1; } else { res.imported += 1; }
        }
    }
    if let Some(sec) = &bundle.security {
        for rule in &sec.custom_rules {
            if cr.contains(&rule.id) {
                if overwrite {
                    state.repo.delete_custom_rule(&rule.id).map_err(|e| e.to_string())?;
                    state.repo.create_custom_rule(rule).map_err(|e| e.to_string())?;
                    res.overwritten += 1;
                } else {
                    res.skipped += 1;
                }
            } else {
                state.repo.create_custom_rule(rule).map_err(|e| e.to_string())?;
                res.imported += 1;
            }
        }
        for br in &sec.builtin_rules {
            if overwrite {
                let _ = state.repo.update_builtin_rule(&br.id, br.enabled, &br.severity);
            }
        }
        // 安全设置直接覆盖(单值无冲突语义)
        *state.security.write() = sec.settings.clone();
    }
    if let Some(fb) = &bundle.fallback {
        *state.fallback.write() = Some((fb.channel_id.clone(), fb.model.clone()));
    }
    if let Some(ac) = &bundle.app_config {
        *state.app.write() = crate::config::settings::AppConfig { preferred_port: ac.preferred_port };
    }
    Ok(res)
}
```

> 说明:`set_role_route`/`upsert_role_pattern` 是 upsert,skip 策略下先判存在再跳过;overwrite 直接 upsert 并计 overwritten。builtin_rules 仅 overwrite 时同步 enabled/severity(它们总是被预置,无"新增"语义)。安全设置/fallback/app_config 写 state;**持久化到 store.bin 由命令层补**(见 Step 3)。

`config/mod.rs` 加 `pub mod restore;`。

- [ ] **Step 3: 命令(含 store 持久化)+ 注册**

`commands/config.rs` 追加:
```rust
use crate::config::restore;
use crate::config::settings::{self as app_settings};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn preview_import(state: State<AppState>, path: String) -> Result<restore::ImportPreview, String> {
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
    // 持久化单值项到 store.bin
    if let Ok(store) = app.store("store.bin") {
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
            Some((channel_id, model)) => { let _ = store.set("fallback", json!({"channel_id": channel_id, "model": model})); }
            None => { let _ = store.set("fallback", serde_json::Value::Null); }
        }
        let _ = store.set("app.preferred_port", json!(state.app.read().preferred_port));
        if let Err(e) = store.save() {
            log::error!("failed to save store after import: {}", e);
        }
    }
    let _ = app_settings::apply_settings; // 保持引用,避免未用 warning(可选)
    Ok(result)
}
```
`lib.rs` 注册 `commands::config::preview_import, commands::config::import_config,`。

> 注:`security.*` 的 store 键名以 `commands/security.rs::set_security_setting` 实际所用键名为准(实现时核对该函数逐字段键名,保持一致)。若键名不同,以既有代码为准。

- [ ] **Step 4: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml import_ preview_ parse_bundle` → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/config/ src-tauri/src/commands/config.rs src-tauri/src/lib.rs
git commit -m "feat(config): 配置导入(preview 冲突计数 + skip/overwrite)"
```

---

### Task 8: 应用配置/CLI 命令(get/set port、write_cli_config、cli_targets)

**Files:**
- Modify: `src-tauri/src/commands/config.rs`(加 `get_app_config`/`set_preferred_port`/`get_cli_targets`/`write_cli_config`)
- Modify: `src-tauri/src/lib.rs`(注册)

**Interfaces:**
- Consumes: Task 1 `state.app`/`state.bound_addr`;Task 4/5 `cli_config::claude_code::write`/`codex::write`;`dirs::home_dir()`。
- Produces:
  - `AppConfigInfo { pub preferred_port: u16, pub bound_addr: Option<String> }`(`Serialize`)
  - `CliTargetInfo { pub target: String, pub configured: bool, pub path: String }`(`Serialize`)
  - 命令 `get_app_config(state) -> AppConfigInfo`、`set_preferred_port(app, state, port: u16) -> Result<(),String>`、`get_cli_targets(state) -> Vec<CliTargetInfo>`、`write_cli_config(state, target: String, api_key_id: String, write_env: bool) -> Result<Vec<CliWriteResult>,String>`

- [ ] **Step 1: 失败测试**

本任务的逻辑薄(主要是胶水 + home_dir/端口注入)。把可单测部分抽为纯函数:`resolve_base_url(bound: Option<SocketAddr>) -> Result<String,String>`:
```rust
#[test]
fn resolve_base_url_requires_bound() {
    assert!(resolve_base_url(None).is_err());
    let addr: std::net::SocketAddr = "127.0.0.1:8779".parse().unwrap();
    assert_eq!(resolve_base_url(Some(addr)).unwrap(), "http://127.0.0.1:8779");
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_base_url` → FAIL。

- [ ] **Step 2: 实现命令**

`commands/config.rs` 追加:
```rust
use crate::cli_config::{self, claude_code, codex, CliWriteResult};
use serde::Serialize;
use std::net::SocketAddr;

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
    bound.map(|a| format!("http://{}", a)).ok_or_else(|| "网关未启动".to_string())
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
    if !(app_settings::MIN_PORT..=app_settings::MAX_PORT).contains(&port) {
        return Err(format!("端口须在 {}..={}", app_settings::MIN_PORT, app_settings::MAX_PORT));
    }
    state.app.write().preferred_port = port;
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set("app.preferred_port", json!(port));
        let _ = store.save();
    }
    Ok(())
}

#[tauri::command]
pub fn get_cli_targets(state: State<AppState>) -> Vec<CliTargetInfo> {
    let bound = state.bound_addr.read().map(|a| a.to_string());
    let mut out = vec![];
    if let Ok(h) = home() {
        let sp = claude_code::settings_path(&h);
        let configured = std::fs::read_to_string(&sp).ok()
            .zip(bound.clone())
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo { target: "claude_code".into(), configured, path: sp.display().to_string() });
        let cp = codex::config_path(&h);
        let configured = std::fs::read_to_string(&cp).ok()
            .zip(bound)
            .map(|(c, b)| c.contains(&b))
            .unwrap_or(false);
        out.push(CliTargetInfo { target: "codex".into(), configured, path: cp.display().to_string() });
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
    let key = keys.into_iter().find(|k| k.id == api_key_id)
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
```
`lib.rs` 注册 `get_app_config, set_preferred_port, get_cli_targets, write_cli_config`。

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_base_url` → PASS;build 干净;全量不回归。
```bash
git add src-tauri/src/commands/config.rs src-tauri/src/lib.rs
git commit -m "feat(config): 应用配置/CLI 命令(端口 + 一键写入入口)"
```

---

### Task 9: 前端 SettingsPage + api wrapper + 导航/路由 + 类型

**Files:**
- Create: `src/pages/SettingsPage.tsx`
- Modify: `src/lib/api.ts`(加 wrapper)
- Modify: `src/types/index.ts`(加类型)
- Modify: `src/App.tsx`(加 `/settings` 路由)
- Modify: `src/components/Layout.tsx`(导航加「设置」)

**Interfaces:**
- Consumes: Task 6/7/8 全部命令;`api.listApiKeys()`(密钥下拉)。
- Produces: 设置页四区(端口 / CLI 一键写入 / 导出 / 导入)。

- [ ] **Step 1: 类型 + api wrapper**

`src/types/index.ts` 追加:
```ts
export interface AppConfigInfo { preferred_port: number; bound_addr: string | null; }
export interface CliTargetInfo { target: string; configured: boolean; path: string; }
export interface CliWriteResult { path: string; changed_keys: string[]; backup_path: string | null; env_instructions: string | null; }
export interface ImportPreview { channels: number; api_keys: number; role_routes: number; role_patterns: number; custom_rules: number; conflicts: number; }
export interface ImportResult { imported: number; skipped: number; overwritten: number; }
```

`src/lib/api.ts` 追加:
```ts
getAppConfig: () => invoke<AppConfigInfo>("get_app_config"),
setPreferredPort: (port: number) => invoke<void>("set_preferred_port", { port }),
getCliTargets: () => invoke<CliTargetInfo[]>("get_cli_targets"),
writeCliConfig: (target: string, apiKeyId: string, writeEnv: boolean) =>
  invoke<CliWriteResult[]>("write_cli_config", { target, apiKeyId, writeEnv }),
exportConfig: (path: string) => invoke<number>("export_config", { path }),
defaultExportPath: () => invoke<string>("default_export_path"),
previewImport: (path: string) => invoke<ImportPreview>("preview_import", { path }),
importConfig: (path: string, strategy: string) =>
  invoke<ImportResult>("import_config", { path, strategy }),
```
并在顶部 import 类型:`AppConfigInfo, CliTargetInfo, CliWriteResult, ImportPreview, ImportResult`。

- [ ] **Step 2: SettingsPage**

`src/pages/SettingsPage.tsx`(函数组件,`useState`/`useEffect`,沿用现有页样式风格:白底卡片、`border rounded p-4`、蓝色主按钮):
- **端口区**:显示 `bound_addr`(只读,未启动显示「未启动」)+ `preferred_port` 数字输入 + 「保存(重启生效)」按钮调 `setPreferredPort`。
- **CLI 写入区**:目标下拉(`claude_code`/`codex`,并用 `getCliTargets` 显示已配置标记与路径)+ 密钥下拉(`listApiKeys`)+ codex 时显示「同时写入用户环境变量」复选框(默认 true)+ 「一键写入」按钮。结果显示每个 `CliWriteResult` 的 `path`/`changed_keys`/`backup_path`;`env_instructions` 非空则 `<pre>` 展示。
- **导出区**:路径输入(挂载时 `defaultExportPath` 预填)+ 「导出」按钮调 `exportConfig`,提示「导出文件含网关访问凭证(sk-lgw),请妥善保管;渠道 api_key 已脱敏,导入后需补填」。
- **导入区**:路径输入 + 「预览」调 `previewImport` 显示各类计数与 `conflicts`;有冲突时弹「跳过已存在 / 覆盖已存在」两按钮,无冲突直接确认;调 `importConfig(path, strategy)` 显示 `imported/skipped/overwritten`。

- [ ] **Step 3: 路由 + 导航**

`App.tsx`:import `SettingsPage`,加 `<Route path="/settings" element={<SettingsPage />} />`。
`Layout.tsx`:import `Settings` from lucide-react,nav 数组加 `{ to: "/settings", label: "设置", icon: Settings }`。

- [ ] **Step 4: typecheck + 提交**

Run: `pnpm typecheck` → 通过;(可选)`pnpm test` 前端单测不回归。
```bash
git add src/
git commit -m "feat(config): 设置页(端口/CLI 一键写入/导入导出)"
```

---

### Task 10: 文档 + 全量验证 + 安全回归

**Files:**
- Create: `docs/app-config.md`(设置/导入导出/CLI 连接说明)

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 中文说明文档 + 验证记录。

- [ ] **Step 1: 写文档**

`docs/app-config.md` 含:首选端口说明(默认 8779,重启生效);Claude Code 写入项(`settings.json` env + `.claude.json` onboarding)与 Codex 写入项(`config.toml` provider + `LLM_GATEWAY_KEY` env);导入导出格式、脱敏策略(渠道 api_key 不导出、文件含 sk-lgw 凭证)、冲突 skip/overwrite;`/v1/responses` 说明(供 Codex,流式为合成终态事件);真实客户端连接冒烟步骤。

- [ ] **Step 2: 全量验证 + 安全 grep**

Run:
- `cargo test --manifest-path src-tauri/Cargo.toml` 全绿。
- `cargo build --manifest-path src-tauri/Cargo.toml` 0 新 warning。
- `pnpm typecheck` 通过。
- 安全 grep(报告贴输出):
  - `grep -rn "api_key" src-tauri/src/config/backup.rs` → 仅见脱敏赋值 `c.api_key = String::new()`。
  - 导出样本文件 `grep -c "sk-real\|sk-***" <导出文件>` → 0(渠道无真实/打码 key;`sk-lgw-` 本地密钥属预期)。
  - `grep -rn "request_body\|response_body" src-tauri/src/config/ src-tauri/src/cli_config/` → 空。
- **真实客户端冒烟(人工/报告记录)**:起 app → 设置页一键写入 Claude Code 与 Codex → 真实 Claude Code / Codex 连接网关各发一条消息验证可用。Codex 流式若对不齐,退化为文档注明「暂用非流式」并在报告说明(spec §5 风险兜底)。

- [ ] **Step 3: 提交**

```bash
git add docs/app-config.md
git commit -m "docs(config): 应用配置/导入导出/CLI 连接说明"
```

---

## Self-Review 记录

- **Spec 覆盖**:§4 端口/bound→Task 1;§5.1 Claude Code→Task 4、§5.2 Codex→Task 5、§5.3 CliWriteResult→Task 4/5;§6 responses 非流式→Task 2、流式→Task 3;§7.1 导出→Task 6、§7.2/7.3 导入+冲突→Task 7;§6 命令→Task 6/7/8;§2 前端设置页→Task 9;§11 文档/验收/安全 grep→Task 10。§9 错误处理(bound None、版本不符、端口校验、逐条计入 skipped)已落入各任务。
- **Placeholder 扫描**:所有代码步骤含完整实现;测试含真实断言与构造;无 TBD/「类似 Task N」。
- **类型一致性**:`CliWriteResult`/`ImportPreview`/`ImportResult`/`ConfigBundle`/`AppConfig` 字段在定义任务与消费任务(前端类型、命令返回)一致;`resolve_base_url` 返回 `http://<addr>`(无 `/v1`),Codex 分支自行 `format!("{}/v1", base_url)`,Claude Code 不带 `/v1`(CC 自拼 `/v1/messages`)——与 spec §5 一致;`merge_*` 纯函数签名在 Task 4/5 与其测试一致。
- **顺序依赖**:Task 1(端口/state)→2/3(responses)→4/5(cli_config)→6(导出)→7(导入,依赖 6 的 ConfigBundle)→8(命令聚合,依赖 1/4/5)→9(前端,依赖 6/7/8)→10(文档)。Task 2/3 与 4-8 可并行,但同改 `handlers.rs`/`commands/config.rs` 时按序避免冲突。
- **遗留风险(如实)**:① Codex SSE 合成对真实客户端的兼容性——Task 10 真实冒烟兜底,不行则降级非流式;② `security.*` store 键名、`SecuritySettings` 是否 derive `Deserialize`——Task 6/7 实现时核对既有代码为准;③ `set_role_route`/`upsert_role_pattern` 为 upsert,skip 语义靠先判存在——已在 Task 7 注释说明。
