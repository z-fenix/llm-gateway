# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 llm-gateway 网关内新增 MCP Server(Streamable HTTP + SSE,rmcp SDK),暴露知识库工具集 + 管理工具 + 用量统计,让 MCP 客户端(如 Claude Code)连接 `http://127.0.0.1:<port>/mcp` 经鉴权后主动检索/管理知识库。

**Architecture:** 新增 `src-tauri/src/mcp/` 模块(`mod.rs` 构造 `/mcp` 路由 + `auth.rs` 鉴权中间件 + `tools.rs` 工具定义),rmcp `StreamableHttpService` 用 `Router::nest_service("/mcp", ...)` 挂进现有 axum server(同端口 8777-8787),工具 handler 薄封装直调现有 `knowledge`/`repository`/`ingest`/统计逻辑,复用 `auth::authorize` 校验 API key(仅校验不耗配额)。

**Tech Stack:** rmcp 3.1.2(Rust MCP SDK,features: server/macros/schemars + dev: client/client-side-sse)、axum 0.8(`nest_service` + `middleware::from_fn_with_state`)、既有 auth/repository/knowledge 层、reqwest、base64、chrono、uuid。

## Global Constraints

- 安全不变量不得回归:真实 `channels.api_key` 永不泄露;MCP 工具不触碰 key(检索经 `knowledge::retrieve`,key 仅经 `auth_header` 进 embedding header);`/mcp` 鉴权失败 → 401,不泄露知识库存在性/内容;工具内部错误返回 MCP error 不 panic;落库 body 始终经 `redact_json_for_logging`(MCP 不新增日志 body 写入)。
- 鉴权复用 `auth::authorize`(仅校验 key 存在+enabled,**不消耗 token 配额**)。
- 锁:生产代码一律 parking_lot `.lock()`(无 `.unwrap()`);测试 mock 内 std Mutex 除外。
- SQL 全参数化(走 repository);不改既有表结构/迁移(仅新增代码)。
- 分支 `feat/mcp-server`(已含 spec commit);提交前缀 `feat(mcp):`/`test(mcp):`/`fix(mcp):`/`docs(mcp):`。
- 每任务验收:`cargo test --manifest-path src-tauri/Cargo.toml` 全绿、`cargo build` 0 新 warning;改前端 `pnpm typecheck`。
- **rmcp API 以实际编译为准**:Task 1 第一步 `cargo add rmcp` 编译验证;本计划代码基于 rmcp **3.1.2** 已核实的 API(`ErrorData as McpError`、`ToolRouter`、`#[tool_router]`/`#[tool_handler]`、`StreamableHttpService`、`StreamableHttpClientTransportConfig::with_uri().auth_header()`),若实际有偏差以实现时真实 API 为准并在报告说明。

---

### Task 1: rmcp 依赖 + mcp 模块骨架 + /mcp 路由(最小冒烟)

**Files:**
- Modify: `src-tauri/Cargo.toml`(加 `rmcp = "3.1.2"`;dev-dependencies 加 `rmcp = { version = "3.1.2", features = ["client", "client-side-sse"] }`、`serde_json` 已有)
- Create: `src-tauri/src/mcp/mod.rs`
- Create: `src-tauri/src/mcp/tools.rs`
- Create: `src-tauri/tests/mcp_smoke.rs`
- Modify: `src-tauri/src/lib.rs`(加 `pub mod mcp;`)
- Modify: `src-tauri/src/proxy/server.rs`(router 加 `.merge(crate::mcp::mcp_router(state.clone()))`)

**Interfaces:**
- Consumes: `AppState`(`#[derive(Clone)]`,含 `repo` 等字段)、`server.rs::router` 现有结构。
- Produces:
  - `src-tauri/src/mcp/mod.rs::pub fn mcp_router(state: AppState) -> axum::Router`(含 `/mcp` 路由,本任务暂不挂鉴权)
  - `src-tauri/src/mcp/tools.rs::pub struct KbMcpServer`(工具服务器,`Clone`,`new(state: AppState)`)+ 占位工具 `kb_list_bases`(Task 3 补真实逻辑)
  - 集成冒烟测试 `tests/mcp_smoke.rs`:起网关 → rmcp client initialize + `tools/list` → 断言含 `kb_list_bases`。

- [ ] **Step 1: 加依赖并编译验证**

```bash
cd /Users/zhouqiao/workplace/project/llm-gateway/src-tauri
cargo add rmcp@3.1.2
cargo add --dev rmcp@3.1.2 --features client,client-side-sse
cargo build
```
预期:build 通过,0 新 warning。若 rmcp 3.1.2 有编译问题,按实际可用版本调整并在报告说明。

- [ ] **Step 2: 失败冒烟测试**

`src-tauri/tests/mcp_smoke.rs`(真实网关,复用 `tests/common/mod.rs` 的模式):
```rust
use rmcp::{
    model::ListToolsRequestParams,
    transport::{StreamableHttpClientTransport, StreamableHttpClientTransportConfig},
    ClientInfo, ServiceExt,
};

#[tokio::test]
async fn mcp_lists_kb_tools() -> anyhow::Result<()> {
    // 起一个真实网关(复用 tests/common 或 server::start + 内存 DB)
    // ... 得到 addr
    let transport = StreamableHttpClientTransport::new_simple(format!("http://{addr}/mcp"));
    let client = ClientInfo::default().serve(transport).await?;
    let tools = client.list_tools(ListToolsRequestParams::default()).await?;
    assert!(tools.tools.iter().any(|t| t.name == "kb_list_bases"));
    Ok(())
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test mcp_smoke` → FAIL(mcp_router 不存在/工具未定义)。

- [ ] **Step 3: 实现 mcp 模块 + 挂路由**

`src-tauri/src/mcp/tools.rs`:
```rust
use crate::proxy::state::AppState;
use rmcp::{
    handler::server::{router::tool::ToolRouter, ServerHandler},
    model::{CallToolResult, ContentBlock},
    tool, tool_router, tool_handler,
};

#[derive(Clone)]
pub struct KbMcpServer {
    state: AppState,
    tool_router: ToolRouter<Self>,
}

impl KbMcpServer {
    pub fn new(state: AppState) -> Self {
        Self { state, tool_router: Self::tool_router() }
    }
}

#[tool_router]
impl KbMcpServer {
    /// 列出所有知识库(占位实现,Task 3 补真实逻辑)
    #[tool(name = "kb_list_bases", description = "列出所有知识库")]
    pub async fn kb_list_bases(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let json = "[]".to_string();
        Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
    }
}

#[tool_handler]
impl ServerHandler for KbMcpServer {}
```

`src-tauri/src/mcp/mod.rs`:
```rust
pub mod tools;

use crate::proxy::state::AppState;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

pub fn mcp_router(state: AppState) -> axum::Router {
    let service: StreamableHttpService<tools::KbMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(tools::KbMcpServer::new(state.clone())),
            Default::default(),
            StreamableHttpServerConfig::default(),
        );
    axum::Router::new().nest_service("/mcp", service)
}
```

`src-tauri/src/lib.rs`:加 `pub mod mcp;`。

`src-tauri/src/proxy/server.rs`:
```rust
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/v1/models", get(handlers::list_models))
        .route("/v1/chat/completions", post(handlers::openai_chat))
        .route("/v1/messages", post(handlers::anthropic_messages))
        .merge(crate::mcp::mcp_router(state.clone()))
        .with_state(state)
}
```

- [ ] **Step 4: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test mcp_smoke` → PASS;`cargo build` 0 新 warning;全量 `cargo test` 不回归。
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/mcp/ src-tauri/src/lib.rs src-tauri/src/proxy/server.rs src-tauri/tests/mcp_smoke.rs
git commit -m "feat(mcp): rmcp 骨架 + /mcp 路由 + 占位工具(冒烟通过)"
```

---

### Task 2: 鉴权中间件(复用 API key,仅校验不耗配额)

**Files:**
- Modify: `src-tauri/src/proxy/handlers.rs`(`fn extract_key` → `pub(crate) fn extract_key`)
- Create: `src-tauri/src/mcp/auth.rs`
- Modify: `src-tauri/src/mcp/mod.rs`(`mcp_router` 加 `.route_layer(middleware::from_fn_with_state(state, auth::mcp_auth))`)
- Modify: `src-tauri/tests/mcp_smoke.rs`(加 401 用例;已有用例补 `auth_header`)

**Interfaces:**
- Consumes: `handlers::extract_key(&HeaderMap) -> Option<String>`(提升后)、`auth::authorize(&Repository, &str) -> AppResult<Result<ApiKey, AuthError>>`(`auth.rs:18`)。
- Produces:
  - `src-tauri/src/mcp/auth.rs::pub async fn mcp_auth(State(state): State<AppState>, headers: HeaderMap, request: Request, next: Next) -> Response`:无 key 或 `authorize` 非 Ok(Ok(_)) → 401 `{"error":"unauthorized"}`;通过 → `next.run(request).await`。
  - `/mcp` 全部请求先过鉴权。

- [ ] **Step 1: 失败测试(401 + 放行)**

`src-tauri/tests/mcp_smoke.rs` 增补:
```rust
#[tokio::test]
async fn mcp_rejects_without_auth() -> anyhow::Result<()> {
    // 起网关(与上例同 setup)
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{addr}/mcp"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#)
        .send()
        .await?;
    assert_eq!(resp.status(), 401);
    Ok(())
}
```
已有 `mcp_lists_kb_tools` 改为经 client transport 加 `auth_header(format!("Bearer {key}"))`:
```rust
let transport = StreamableHttpClientTransport::new(
    reqwest::Client::new(),
    StreamableHttpClientTransportConfig::with_uri(format!("http://{addr}/mcp"))
        .auth_header(format!("Bearer {key}")),
);
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test mcp_smoke` → 401 用例 FAIL(当前无鉴权)。

- [ ] **Step 2: 实现鉴权中间件 + 挂接**

`src-tauri/src/proxy/handlers.rs`:把 `fn extract_key` 改为 `pub(crate) fn extract_key`(仅改可见性,签名不变)。

`src-tauri/src/mcp/auth.rs`:
```rust
use crate::auth;
use crate::proxy::handlers::extract_key;
use crate::proxy::state::AppState;
use axum::{
    extract::{Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// /mcp 鉴权:复用 API key 校验(x-api-key 或 Bearer),仅校验不耗配额。
pub async fn mcp_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    let Some(key) = extract_key(&headers) else {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
    };
    match auth::authorize(&state.repo, &key) {
        Ok(Ok(_)) => next.run(request).await,
        _ => (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response(),
    }
}
```

`src-tauri/src/mcp/mod.rs`:
```rust
pub mod auth;
pub mod tools;

use crate::proxy::state::AppState;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

pub fn mcp_router(state: AppState) -> axum::Router {
    let service: StreamableHttpService<tools::KbMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(tools::KbMcpServer::new(state.clone())),
            Default::default(),
            StreamableHttpServerConfig::default(),
        );
    axum::Router::new()
        .nest_service("/mcp", service)
        .route_layer(axum::middleware::from_fn_with_state(state, auth::mcp_auth))
}
```

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test mcp_smoke` → 两用例 PASS;`cargo build` 干净;全量 `cargo test` 不回归。
```bash
git add src-tauri/src/proxy/handlers.rs src-tauri/src/mcp/ src-tauri/tests/mcp_smoke.rs
git commit -m "feat(mcp): /mcp 鉴权中间件(复用 API key,401/放行)"
```

---

### Task 3: 浏览/检索工具(kb_list_bases / kb_get_base / kb_search)

**Files:**
- Modify: `src-tauri/src/mcp/tools.rs`(kb_list_bases 真实现 + kb_get_base + kb_search + `#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]` 参数结构体 + 可单测的核心逻辑函数)

**Interfaces:**
- Consumes: Task 1 `KbMcpServer`/`ToolRouter`;`repo.list_kbs()/get_kb(&str)/get_kb_by_name(&str)/list_documents(&str)`;`knowledge::retrieve(state, kb, query, top_n) -> Result<Vec<RetrievedChunk>, String>`(async);`state.rag.read().default_kb`。
- Produces(全部走「核心逻辑函数 + 工具薄封装」模式,核心函数返回 `Result<String, String>`(JSON 文本)可单测):
  - `impl KbMcpServer::async fn do_kb_list_bases(&self) -> Result<String, String>`(repo.list_kbs → JSON 数组)
  - `async fn do_kb_get_base(&self, kb_id: String) -> Result<String, String>`(先 `get_kb(&kb_id)` 按 id,失败按 `get_kb_by_name`,都不存在 → Err;返回库详情 + 文档数)
  - `async fn do_kb_search(&self, query: String, kb_id: Option<String>, top_k: Option<usize>) -> Result<String, String>`(kb 定位:传值则 id→name,不传用 `state.rag.read().default_kb`;`top_k = top_k.unwrap_or(5).min(20)`;`retrieve(state, &kb, &query, top_k)` → JSON)
  - 工具方法 `kb_list_bases`/`kb_get_base`/`kb_search` 包装上 3 个,`CallToolResult::success(vec![ContentBlock::text(json)])`;错误用 `ErrorData::new(ErrorCode::INTERNAL_ERROR, e, None)`。

- [ ] **Step 1: 失败测试(核心逻辑函数)**

`src-tauri/src/mcp/tools.rs` 内 `#[cfg(test)]`(内存 DB + temp kb_index_dir;直接调 `do_*` 函数):
```rust
#[tokio::test]
async fn kb_search_uses_default_kb_when_id_omitted() {
    // 造 AppState(内存 DB):建库 kb1(name="kb1", embedding_channel 指向 mock /v1/embeddings),
    // 摄取一含关键词文档(复用 ingest::spawn_ingest 或直接插 chunk+索引),rag.default_kb = Some("kb1")
    // do_kb_search("关键词", None, None) → Ok(JSON),断言含片段 content 与来源 filename
}
#[tokio::test]
async fn kb_search_resolves_by_name_and_caps_top_k() {
    // do_kb_search("关键词", Some("kb1"), Some(999)) → top_k 应被 20 截断(retrieve 不报错)
}
#[tokio::test]
async fn kb_get_base_resolves_id_or_name_and_errors_when_missing() {
    // do_kb_get_base("kb1") → Ok 含 name;do_kb_get_base("nope") → Err
}
#[tokio::test]
async fn kb_list_bases_returns_json_array() {
    // 建 2 库 → do_kb_list_bases() → JSON 数组长度 2
}
```
(参照 `tests/kb_rag.rs`/`knowledge::ingest` 单测的 mock embedding + temp 索引 + 摄取模式构造。)

Run: `cargo test --manifest-path src-tauri/Cargo.toml kb_search_` / `kb_get_base_` / `kb_list_bases_` → FAIL(函数未定义)。

- [ ] **Step 2: 实现核心逻辑 + 工具薄封装**

按上。`kb_search` 库定位辅助:
```rust
fn resolve_kb(&self, kb_id: Option<String>) -> Result<KnowledgeBase, String> {
    let id = match kb_id {
        Some(id) => id,
        None => self.state.rag.read().default_kb.clone()
            .ok_or_else(|| "no kb specified and no default_kb".to_string())?,
    };
    if let Some(kb) = self.state.repo.get_kb(&id).map_err(|e| e.to_string())? {
        return Ok(kb);
    }
    self.state.repo.get_kb_by_name(&id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("knowledge base not found: {id}"))
}
```
工具方法(以 kb_search 为例):
```rust
#[tool(name = "kb_search", description = "按 query 检索知识库片段")]
pub async fn kb_search(
    &self,
    Parameters(args): Parameters<KbSearchArgs>,
) -> Result<CallToolResult, rmcp::ErrorData> {
    self.do_kb_search(args.query, args.kb_id, args.top_k).await
        .map(|json| CallToolResult::success(vec![ContentBlock::text(json)]))
        .map_err(|e| rmcp::model::ErrorData::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e, None))
}
```
参数结构体:
```rust
#[derive(serde::Deserialize, rmcp::schemars::JsonSchema)]
pub struct KbSearchArgs {
    pub query: String,
    #[schemars(description = "知识库 id 或 name;缺省用 rag.default_kb")]
    pub kb_id: Option<String>,
    #[schemars(description = "返回片段数,默认 5,上限 20")]
    pub top_k: Option<usize>,
}
```
`KbGetBaseArgs { kb_id: String }` 同理。`kb_list_bases` 无参。顶部 `use rmcp::handler::server::wrapper::Parameters;`。

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml kb_search_` 等 → PASS;`cargo test --test mcp_smoke` → PASS(工具仍可列出);`cargo build` 干净;全量不回归。
```bash
git add src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): 浏览/检索工具(kb_list_bases/kb_get_base/kb_search)"
```

---

### Task 4: 管理 + 统计工具(kb_create / kb_upload / kb_delete / stats_quota)

**Files:**
- Modify: `src-tauri/src/commands/knowledge.rs`(`fn file_type_str` → `pub(crate) fn file_type_str`;`fn kb_index_path` → `pub(crate) fn kb_index_path`)
- Modify: `src-tauri/src/mcp/tools.rs`(kb_create / kb_upload / kb_delete / stats_quota + 参数结构体 + 核心逻辑)

**Interfaces:**
- Consumes: Task 3 模式;`repo.create_kb(&KnowledgeBase)/delete_kb(&str)/insert_document(&KbDocument)/get_kb(&str)`;`commands::knowledge::file_type_str(&filename) -> &'static str`/`kb_index_path(state, &str) -> PathBuf`(提升后);`ingest::stage_content(state, doc_id, &[u8])`、`ingest::spawn_ingest(state, doc_id)`;`state.repo.stats() -> (today_req, today_tokens, total_req, total_tokens, active_channels, avg_latency_ms)`(对照 `commands/stats.rs` 的 `Stats` 字段);`state.rag.read().default_embedding_channel`。
- Produces:
  - `async fn do_kb_create(&self, name: String, description: Option<String>, embedding_channel_id: Option<String>, embedding_model: String) -> Result<String, String>`(校验 name 非空;`create_kb`;返回新库 JSON)
  - `async fn do_kb_upload(&self, kb_id: String, filename: String, content: String) -> Result<String, String>`(校验库存在;`KbDocument` 构造(status="indexing",file_type=file_type_str);`insert_document`;`stage_content(state, doc_id, content.as_bytes())`;`spawn_ingest(state.clone(), doc_id)`;返回文档 JSON)
  - `async fn do_kb_delete(&self, kb_id: String) -> Result<String, String>`(`delete_kb` + `kb_index_path` 删索引文件(尽力而为))
  - `async fn do_stats_quota(&self) -> Result<String, String>`(`repo.stats()` → JSON,字段同 `Stats`)

- [ ] **Step 1: 失败测试**

`src-tauri/src/mcp/tools.rs` `#[cfg(test)]`:
```rust
#[tokio::test]
async fn kb_create_persists_and_returns_base() {
    // do_kb_create("kb2", None, None, "text-embedding") → JSON 含 name="kb2";repo.list_kbs 含之
}
#[tokio::test]
async fn kb_create_rejects_empty_name() {
    // do_kb_create("", None, None, "m") → Err
}
#[tokio::test]
async fn kb_upload_stages_and_spawns_ingest() {
    // 建库 → do_kb_upload(kb_id, "guide.md", "## 标题\nRAG 关键词内容") → JSON 含 status="indexing";
    // 等待异步摄取(轮询 repo 文档 status)→ "indexed";repo.list_chunks 非空
}
#[tokio::test]
async fn kb_upload_rejects_unknown_base() {
    // do_kb_upload("nope", "a.md", "x") → Err("knowledge base not found")
}
#[tokio::test]
async fn kb_delete_removes_base_and_index() {
    // 建库 + 摄取 → do_kb_delete → repo.get_kb 为 None;索引文件不存在
}
#[tokio::test]
async fn stats_quota_returns_aggregates() {
    // do_stats_quota → JSON 含 total_requests 字段(数值)
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml kb_create_` / `kb_upload_` / `kb_delete_` / `stats_quota_` → FAIL。

- [ ] **Step 2: 实现**

按上。`kb_upload` 与 `commands::knowledge::upload_document` 流程一致(仅内容来源是纯文本而非 base64 解码,直接 `stage_content(state, &doc.id, content.as_bytes())`);id 用 `uuid::Uuid::new_v4().to_string()`;`created_at` 用 `chrono::Utc::now().timestamp()`。`kb_index_path` 删除索引文件:
```rust
let index_path = commands::knowledge::kb_index_path(&self.state, &kb_id);
let _ = std::fs::remove_file(&index_path);
```
`stats_quota` 字段映射(对照 `commands/stats.rs::Stats`):
```rust
let (tr, tt, ar, at, ac, lat) = self.state.repo.stats().map_err(|e| e.to_string())?;
let json = serde_json::json!({
    "today_requests": tr, "today_tokens": tt,
    "total_requests": ar, "total_tokens": at,
    "active_channels": ac, "avg_latency_ms": lat,
});
```

- [ ] **Step 3: 测试通过 + 提交**

Run: 上述测试 → PASS;`cargo test --test mcp_smoke` → PASS;`cargo build` 干净;全量 `cargo test` 不回归。
```bash
git add src-tauri/src/commands/knowledge.rs src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): 管理/统计工具(kb_create/kb_upload/kb_delete/stats_quota)"
```

---

### Task 5: e2e 集成测试(真实网关 MCP 全链路)+ 安全回归 grep

**Files:**
- Create: `src-tauri/tests/mcp_e2e.rs`
- Modify: `src-tauri/tests/mcp_smoke.rs`(若需并入,可保留或删除——见 Step 3)

**Interfaces:**
- Consumes: Task 1-4 全部;`tests/common/mod.rs` 的 mock 模式(`/v1/embeddings` 已存在,kb_rag 用过);rmcp client。
- Produces: 经真实网关的 MCP 全链路测试 + 安全回归 grep。

**关键实现点:**
- setup:mock embedding(定维向量)+ mock chat 上游;造 channel + api_key(sk-lgw-*);内存 DB + temp kb_index_dir;`server::start` 起网关;rmcp client transport 带 `auth_header("Bearer <key>")`。
- 覆盖:
  1. `initialize` → `tools/list` → 断言 7 个工具(`kb_list_bases/kb_get_base/kb_search/kb_create/kb_upload/kb_delete/stats_quota`)。
  2. `kb_create` → `kb_upload`(摄取一文档)→ 轮询文档 indexed → `kb_search` 命中 → `kb_get_base` → `kb_delete`。
  3. `stats_quota` 返回数值字段。
  4. **401**:无鉴权头 reqwest POST `/mcp` → 401(已在 Task 2,此处再断言有效 key 但禁用 → 401)。
  5. **降级**:embedding mock 切 500 → `kb_search` 返回 MCP error(工具错误,不 panic),网关仍 200 级响应(JSON-RPC error 而非 HTTP 5xx)。
- 安全回归 grep(报告贴输出):`grep -rn "api_key" src-tauri/src/mcp/`(应仅在测试/无 key 字段);`grep -rn "request_body\|response_body" src-tauri/src/mcp/`(应为空)。

- [ ] **Step 1: 失败 e2e**

按上写 `tests/mcp_e2e.rs`。Run: `cargo test --manifest-path src-tauri/Cargo.toml --test mcp_e2e` → FAIL→PASS(工具未齐/断言未满足先 FAIL)。

- [ ] **Step 2: 安全 grep + 全量测试**

执行两条 grep 并确认无泄漏;`cargo test` 全量 → 绿,0 新 warning;`cargo build` 干净。

- [ ] **Step 3: 提交**

若 `mcp_smoke.rs` 用例被 mcp_e2e 完全覆盖,删除 smoke 文件避免重复(报告说明);否则保留。
```bash
git add src-tauri/tests/
git commit -m "test(mcp): MCP 全链路 e2e(7 工具/鉴权/降级)+ 安全回归"
```

---

### Task 6: 连接说明文档 + 全量验证 + 收尾

**Files:**
- Create: `docs/mcp.md`(MCP 客户端连接说明)

**Interfaces:**
- Consumes: 全部后端任务。
- Produces: `docs/mcp.md` 含:URL `http://127.0.0.1:<port>/mcp`、鉴权 `Authorization: Bearer <sk-lgw-*>`、Claude Code mcp 配置 JSON 示例、7 个工具清单与参数、连接冒烟步骤(可选 MCP inspector)。

- [ ] **Step 1: 写文档**

`docs/mcp.md`(中文,示例可复制):
```markdown
# MCP Server

llm-gateway 内嵌 MCP Server(Streamable HTTP),MCP 客户端可连接并调用知识库工具。

## 连接

- URL:`http://127.0.0.1:<port>/mcp`(网关端口 8777-8787 中实际占用者)
- 鉴权:复用本地 API key,头 `Authorization: Bearer sk-lgw-...`(或 `x-api-key`)
- 获取密钥:网关前端「API 密钥」页创建

Claude Code `~/.claude.json` 的 mcpServers 配置示例:
```json
{ "mcpServers": { "llm-gateway": {
  "url": "http://127.0.0.1:8779/mcp",
  "headers": { "Authorization": "Bearer sk-lgw-<你的密钥>" }
}}}
```

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| kb_list_bases | - | 列出所有知识库 |
| kb_get_base | kb_id | 单库详情 + 文档数(id 或 name) |
| kb_search | query, kb_id?, top_k? | 检索片段(默认库/默认 5/上限 20) |
| kb_create | name, description?, embedding_channel_id?, embedding_model | 建库 |
| kb_upload | kb_id, filename, content | 上传纯文本文档(异步摄取) |
| kb_delete | kb_id | 删除库(级联+索引) |
| stats_quota | - | 全局用量统计 |
```

## 冒烟

```bash
# 起 app 后,用任意 MCP client 连接;或:
curl -s -X POST http://127.0.0.1:8779/mcp -H 'Authorization: Bearer sk-lgw-xxx' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```
```

- [ ] **Step 2: 全量验证**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` 全绿;`cargo build --manifest-path src-tauri/Cargo.toml` 0 新 warning;`grep -rn "todo!\|unimplemented!" src-tauri/src/mcp/` 为空。

- [ ] **Step 3: 提交**

```bash
git add docs/mcp.md
git commit -m "docs(mcp): MCP 客户端连接说明"
```

---

## Self-Review 记录

- **Spec 覆盖**:§2 架构(/mcp 路由、rmcp、薄模块)→Task 1/2;§3 工具集 7 工具→Task 3/4;§4 鉴权/安全→Task 2 + Task 5 安全 grep;§5 测试→各任务 Step + Task 5 e2e;§6 连接说明→Task 6;§1 范围/非目标→不实现代理聊天/CLI 配置。
- **Placeholder 扫描**:所有任务含完整代码或精确测试名与断言;rmcp 3.1.2 API 已逐项核实(`ErrorData as McpError`、`ToolRouter` import 路径、`Parameters` wrapper、`StreamableHttpService::new` 三参、client `auth_header`),Task 1 Step 1 的 `cargo add` 编译验证为依赖核实兜底(网络受限,与 usearch/tree-sitter 同策略),非占位。
- **类型一致性**:工具参数结构体(`KbSearchArgs` 等)与 `do_*` 核心函数签名一致;`file_type_str`/`kb_index_path` 提升 pub(crate) 后命令层与 mcp 共用同一签名;`stats_quota` 字段与 `commands/stats.rs::Stats`(today_requests/today_tokens/total_requests/total_tokens/active_channels/avg_latency_ms)一致;工具名(kb_list_bases 等)在 tools.rs 定义、smoke/e2e 断言、docs 三处一致。
- **顺序依赖**:Task 1(骨架/路由)→2(鉴权)→3(浏览/检索)→4(管理/统计)→5(e2e)→6(文档)。Task 2 改动 extract_key 可见性不影响既有调用;Task 3/4 的 mock 摄取复用 `tests/kb_rag.rs`/ingest 单测模式。
