# 会话 / Skills / Prompt / MCP 服务器管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/feature.md` 的 4 个管理功能：Prompt 管理（CLAUDE.md 模板 + 启用互斥写盘）、会话管理（request_logs 按 trace_id 聚合的主从页）、MCP 服务器管理（上游 MCP server 列表 + 真实 client 连接）、Skills 管理（本地库 + 目录同步）。

**Architecture:** 3 个新迁移（007 prompts / 008 mcp_servers / 009 skills）+ 4 个命令模块（prompt/session/mcp_server/skill）+ 1 个 mcp_client 运行时模块（rmcp client：stdio child-process + streamable-http）+ 4 个新前端页面。AppState 增 `mcp_clients`。全部复用现有 cc-switch 设计系统与「命令 + 表 + 页面」模式。

**Tech Stack:** Rust (rusqlite, rmcp client), React 18 + TypeScript + Tailwind (Tauri 前端), Vitest。

**Spec:** `docs/superpowers/specs/2026-08-23-llm-gateway-sessions-skills-prompts-mcp-design.md`

## Global Constraints

- 不改表结构（新增 007/008/009 迁移；现有表不动）。
- 新命令全部注册进 `invoke_handler!`（lib.rs）+ `src/lib/api.ts`（camelCase 参数键）。
- 写盘目标：Prompt 写 `~/.claude/CLAUDE.md`、Skills 写 `~/.claude/skills/<dir>/SKILL.md`；均先 `backup_and_write`（备份 `.bak-{ts}`），写盘失败回滚 DB 状态。
- Prompt 启用互斥（一次仅一个 enabled）。
- Skills `directory` 白名单 `[A-Za-z0-9_-]`（防路径穿越）。
- MCP：stdio 需 command、http 需 url（校验）；connect/test 加超时（5s）；连接失败返回错误。
- 不把上游 MCP 工具合并进 `/mcp` 知识库工具集（本阶段只建立连接与管理）。
- `cargo test --lib`、`pnpm typecheck`、`pnpm test:unit` 全绿（e2e 若受本机系统代理 503 影响，用 `NO_PROXY=127.0.0.1,localhost`）。
- 前端 UI 文本中文；不改现有 8 个页面的行为。

---

### Task 1: 共享基础设施（3 迁移 + 4 模型 + repository 方法）

**Files:**
- Create: `src-tauri/migrations/007_prompts.sql`, `008_mcp_servers.sql`, `009_skills.sql`
- Modify: `src-tauri/src/db/mod.rs`（注册 3 个迁移）
- Modify: `src-tauri/src/db/models.rs`（`Prompt`, `Skill`, `McpServer`, `SessionMeta`, `SessionMessage`）
- Modify: `src-tauri/src/db/repository.rs`（prompt/skill/mcp_server CRUD + session 聚合/详情/删除）
- Test: `cargo test --lib db::repository`（新增测试）

**Interfaces:**
- Produces 模型（serde 字段名 snake_case，前端 types 同步）:
  - `Prompt { id, name, content, description: Option<String>, enabled: bool, created_at: i64, updated_at: i64 }`
  - `Skill { id, name, description: Option<String>, directory: String, content: String, enabled: bool, created_at: i64, updated_at: i64 }`
  - `McpServer { id, name, server_config: serde_json::Value, description: Option<String>, enabled: bool, created_at: i64, updated_at: i64 }`
  - `SessionMeta { trace_id: String, title: Option<String>, first_active: i64, last_active: i64, message_count: i64, roles: Vec<(String, i64)> }`
  - `SessionMessage { seq: i64, role: Option<String>, content: Option<String>, status_code: Option<i64>, created_at: i64, error: Option<String> }`
- Produces repository 方法（供 Task 2/4/6/8 命令调用）:
  - `list_prompts() -> AppResult<Vec<Prompt>>`, `get_prompt(id)`, `upsert_prompt(p: &Prompt)`, `delete_prompt(id)`, `set_prompt_enabled(id, enabled) -> AppResult<()>`（互斥：先全关再开）
  - `list_skills()`, `get_skill(id)`, `upsert_skill(s: &Skill)`, `delete_skill(id)`, `set_skill_enabled(id, enabled)`
  - `list_mcp_servers()`, `get_mcp_server(id)`, `upsert_mcp_server(s: &McpServer)`, `delete_mcp_server(id)`, `set_mcp_server_enabled(id, enabled)`
  - `list_sessions() -> AppResult<Vec<SessionMeta>>`（`SELECT trace_id, MIN(created_at), MAX(created_at), COUNT(*) FROM request_logs GROUP BY trace_id ORDER BY MAX(created_at) DESC`，roles 子查询）
  - `get_session_messages(trace_id) -> AppResult<Vec<SessionMessage>>`
  - `delete_session(trace_id) -> AppResult<usize>`（事务：先删 `request_security_findings WHERE log_id IN (SELECT id FROM request_logs WHERE trace_id=?)` 再删 request_logs）

- [ ] **Step 1: 迁移文件**

`007_prompts.sql`:
```sql
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
`008_mcp_servers.sql`:
```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_config TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
`009_skills.sql`:
```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  directory TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
`db/mod.rs` MIGRATIONS 数组追加 3 个 `include_str!`。

- [ ] **Step 2: models.rs 增 5 个结构**

`Prompt`, `Skill`, `McpServer`（`server_config: serde_json::Value`，serde 需要 `Value` 的 Deserialize——已由 serde_json derive 支持）、`SessionMeta`, `SessionMessage`。均 `#[derive(Debug, Clone, Serialize, Deserialize)]`。

- [ ] **Step 3: repository 方法**

按上面 Interfaces 的签名实现。`list_sessions` 用两条 SQL（先聚合 meta 再 `GROUP BY trace_id, role` 填 roles）；`delete_session` 事务（镜像 `delete_logs_before` 的事务模式）。`set_prompt_enabled` 互斥：事务内 `UPDATE prompts SET enabled=0` 然后 `UPDATE prompts SET enabled=1 WHERE id=?1`（enabled=false 时直接 `SET enabled=0 WHERE id=?1`）。

- [ ] **Step 4: 单测**

`db/repository.rs` tests 增：
- `prompt_crud_and_enable_exclusive`（插 2 条 → enable A → B 也 enable → A 自动关）
- `skill_and_mcp_server_crud_roundtrip`
- `list_sessions_groups_by_trace`（插 2 个 trace 各 2 条日志 → 断言 2 个 SessionMeta 字段）
- `get_session_messages_orders_by_seq`
- `delete_session_cascades_findings`（插日志+findings → 删 → 断言清空）

- [ ] **Step 5: 运行验证**

```bash
cd src-tauri && cargo test --lib db::repository -- --nocapture && cargo test --lib 2>&1 | tail -3 && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/migrations/007_prompts.sql src-tauri/migrations/008_mcp_servers.sql src-tauri/migrations/009_skills.sql src-tauri/src/db/mod.rs src-tauri/src/db/models.rs src-tauri/src/db/repository.rs
git commit -m "feat(db): prompts/mcp_servers/skills 表+模型+repository(含会话聚合)"
```

---

### Task 2: Prompt 命令（CRUD + 启用写盘）

**Files:**
- Create: `src-tauri/src/commands/prompt.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod prompt;`）
- Modify: `src-tauri/src/lib.rs`（注册 5 个命令）
- Test: `cargo test --lib commands::prompt`

**Interfaces:**
- Consumes: `Repository::{list_prompts, get_prompt, upsert_prompt, delete_prompt, set_prompt_enabled}`、`cli_config::backup_and_write`。
- Produces 命令:
  - `list_prompts(state) -> Vec<Prompt>`
  - `upsert_prompt(state, id: Option<String>, name, content, description: Option<String>) -> Prompt`
  - `delete_prompt(state, id)`（已启用者拒绝）
  - `enable_prompt(state, id)`（互斥 + 写盘 `~/.claude/CLAUDE.md`，失败回滚）
  - `get_enabled_prompt(state) -> Option<Prompt>`

- [ ] **Step 1: 命令实现**

写盘辅助（可注入 home 便于测试）：
```rust
fn claude_dir(home: &Path) -> PathBuf { home.join(".claude") }
fn settings_path(home: &Path) -> PathBuf { claude_dir(home).join("CLAUDE.md") }

pub(crate) fn enable_prompt_with_home(state: &AppState, home: &Path, id: &str) -> Result<(), String> {
    let prompt = state.repo.get_prompt(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "prompt not found".to_string())?;
    // 先启用（互斥），再写盘；写盘失败回滚启用状态
    state.repo.set_prompt_enabled(id, true).map_err(|e| e.to_string())?;
    let path = settings_path(home);
    let ok = crate::cli_config::backup_and_write(&path, &prompt.content);
    match ok {
        Ok(_) => Ok(()),
        Err(e) => {
            state.repo.set_prompt_enabled(id, false).ok();
            Err(e)
        }
    }
}
```
`upsert_prompt_with_home` 不涉及 home（纯 DB），但为测试一致性也拆 `_with_state` 辅助。命令薄包装。校验：name/content 非空 trim；id 空则 `uuid::Uuid::new_v4()`。

`enable_prompt` 命令：`enable_prompt_with_home(&state, &dirs::home_dir().ok_or("无法确定用户主目录")?, &id)`。

- [ ] **Step 2: 单测**

`commands/prompt.rs` tests（tempdir + `AppState::new(Db::new_in_memory())`，用 `_with_home`）：
- `upsert_creates_and_validates`（空 name → Err）
- `enable_writes_file_and_exclusive`（2 条 prompt → enable A → `~/.claude/CLAUDE.md` 内容=A → enable B → A.enabled=false、文件=B）
- `delete_enabled_rejected`
- `enable_backup_created`（先写旧 CLAUDE.md → enable → `.bak-*` 存在）

- [ ] **Step 3: 运行验证**

```bash
cd src-tauri && cargo test --lib commands::prompt -- --nocapture && cargo test --lib 2>&1 | tail -3 && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/prompt.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(prompt): Prompt CRUD+启用互斥+写盘 CLAUDE.md"
```

---

### Task 3: Prompt 前端页面 + 导航

**Files:**
- Create: `src/pages/PromptsPage.tsx`
- Modify: `src/App.tsx`（route `/prompts`）
- Modify: `src/components/Layout.tsx`（nav 项）
- Modify: `src/lib/api.ts`, `src/types/index.ts`
- Create: `src/pages/__tests__/PromptsPage.test.tsx`
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.listPrompts()`, `api.upsertPrompt(id|null, name, content, description)`, `api.deletePrompt(id)`, `api.enablePrompt(id)`, `api.getEnabledPrompt()`。
- Produces: PromptsPage 页面。

- [ ] **Step 1: types + api**

`types/index.ts`: `export interface Prompt { id: string; name: string; content: string; description: string | null; enabled: boolean; created_at: number; updated_at: number; }`
`api.ts`:
```ts
listPrompts: () => invoke<Prompt[]>("list_prompts"),
upsertPrompt: (id: string | null, name: string, content: string, description: string | null) =>
  invoke<Prompt>("upsert_prompt", { id, name, content, description }),
deletePrompt: (id: string) => invoke<void>("delete_prompt", { id }),
enablePrompt: (id: string) => invoke<void>("enable_prompt", { id }),
getEnabledPrompt: () => invoke<Prompt | null>("get_enabled_prompt"),
```

- [ ] **Step 2: PromptsPage**

PageHeader("Prompt 管理" + 描述"多套 CLAUDE.md 模板，启用后写入 ~/.claude/CLAUDE.md（自动备份）")。Card 列表：每行 name + description + `enabled` Switch（`onCheckedChange` → `api.enablePrompt(id)`，成功 toast "已写入 ~/.claude/CLAUDE.md"）+ 编辑/删除按钮（删除 ConfirmDialog，enabled 项删除报错 toast）。新增/编辑 Dialog：name Input + description Input + content textarea（`min-h-[320px] font-mono`）+ 保存（校验非空）。EmptyState 空态。挂载 `listPrompts`。

- [ ] **Step 3: App.tsx + Layout.tsx**

App.tsx 加 `<Route path="/prompts" element={<PromptsPage />} />`；Layout.tsx nav 加 `{ to: "/prompts", label: "Prompt", icon: FileText }`（lucide `FileText` 导入）。

- [ ] **Step 4: 测试**

`PromptsPage.test.tsx`（mock api）：渲染列表；点启用 → `enablePrompt` 被调；新增 dialog → 填 name/content → 保存 → `upsertPrompt` 被调（参数正确）。

- [ ] **Step 5: 运行验证**

```bash
pnpm typecheck && pnpm test:unit
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/PromptsPage.tsx src/App.tsx src/components/Layout.tsx src/lib/api.ts src/types/index.ts src/pages/__tests__/PromptsPage.test.tsx
git commit -m "feat(ui): Prompt 管理页 + 导航"
```

---

### Task 4: 会话管理命令

**Files:**
- Create: `src-tauri/src/commands/session.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `cargo test --lib commands::session`

**Interfaces:**
- Consumes: `Repository::{list_sessions, get_session_messages, delete_session}`。
- Produces: `list_sessions(state) -> Vec<SessionMeta>`、`get_session_messages(state, trace_id) -> Vec<SessionMessage>`、`delete_session(state, trace_id) -> usize`。前端 api `listSessions()` / `getSessionMessages(traceId)` / `deleteSession(traceId)`。

- [ ] **Step 1: 命令**

薄命令直接调 repository（无 home/写盘，无需 `_with_state` 拆——但为单测可测性拆 `_with_state`，沿用模式）。`get_session_messages` 的 `content` 提取：解析 request_body JSON 取 `messages[0].content`（string 则用，array 取首 text block），截断 200 字符；response 摘要取 `response_body.content[0].text` 或 choices[0].message.content，截断 200。若解析失败则用原始 body 字符串前 100 字符。

- [ ] **Step 2: 单测**

`commands/session.rs` tests：插日志（不同 trace、不同 seq）→ `list_sessions_with_state` 断言 meta；`get_session_messages_with_state` 断言排序与 content 提取；`delete_session_with_state` 断言返回行数 + 再查空。

- [ ] **Step 3: 运行验证 + Commit**

同前模式；commit `feat(session): 会话列表/详情/删除命令`。

---

### Task 5: 会话管理前端（主从页）

**Files:**
- Create: `src/pages/SessionsPage.tsx`
- Modify: `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/api.ts`, `src/types/index.ts`
- Create: `src/pages/__tests__/SessionsPage.test.tsx`
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.listSessions()`, `api.getSessionMessages(traceId)`, `api.deleteSession(traceId)`。
- Produces: SessionsPage。

- [ ] **Step 1: types + api**

`SessionMeta { trace_id, title: string|null, first_active, last_active, message_count, roles: [string, number][] }`, `SessionMessage { seq, role: string|null, content: string|null, status_code: number|null, created_at, error: string|null }`。
api: `listSessions`, `getSessionMessages`, `deleteSession`。

- [ ] **Step 2: SessionsPage**

`grid md:grid-cols-[320px_1fr]` 主从布局：
- 左 Card：PageHeader 简版（"会话管理"）+ 搜索 Input（前端 filter trace_id/title）+ 会话列表（每行 title 或 trace_id 短码 + 相对时间 + 消息数 badge + 角色 badge）。空态 EmptyState。
- 右 Card：选中会话详情——头部 trace_id（mono）+ first/last 时间 + 删除按钮（ConfirmDialog）；消息列表（每行 role badge + content 摘要，点展开显示 request/response body——复用 LogsPage 的 prettyJson 心智 + `max-h` pre）。空态提示"选择左侧会话"。
- 挂载 `listSessions`；点会话 → `getSessionMessages`；删除 → `deleteSession` + 刷新。

- [ ] **Step 3: App.tsx + Layout.tsx**

route `/sessions` + nav `{ to: "/sessions", label: "会话", icon: MessagesSquare }`（lucide）。

- [ ] **Step 4: 测试**

mock api：列表渲染 + 搜索过滤；点会话 → `getSessionMessages` 被调 + 消息渲染；删除 → `deleteSession` 被调。

- [ ] **Step 5: 运行验证 + Commit**

commit `feat(ui): 会话管理主从页(按 trace_id)`。

---

### Task 6: MCP 服务器命令 + client 运行时

**Files:**
- Modify: `src-tauri/Cargo.toml`（rmcp 正式依赖增 client features）
- Create: `src-tauri/src/mcp_client/mod.rs`
- Create: `src-tauri/src/commands/mcp_server.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/proxy/state.rs`（AppState.mcp_clients）
- Test: `cargo test --lib commands::mcp_server` + mcp_client 模块测试

**Interfaces:**
- Produces: `AppState.mcp_clients: Arc<RwLock<HashMap<String, tokio::task::JoinHandle<()>>>>`；命令 `list_mcp_servers`（附 `connected` 从 mcp_clients 查）/ `upsert_mcp_server` / `delete_mcp_server`（先 disconnect）/ `toggle_mcp_server_enabled` / `test_mcp_connection` / `connect_mcp_server` / `disconnect_mcp_server`。

- [ ] **Step 1: Cargo.toml + AppState**

正式依赖改为：
```toml
rmcp = { version = "3.1.2", features = ["client", "transport-child-process", "transport-streamable-http-client-reqwest", "transport-streamable-http-server"] }
```
（合并 dev 的 client features 到正式依赖；dev-dependencies 那行删除或保留 client 均可——若正式已含则删 dev 的 rmcp 条目以免重复 feature 声明冲突。验证 `cargo check`。）
`state.rs` 加字段 + init：
```rust
pub mcp_clients: Arc<RwLock<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>>,
// init: mcp_clients: Arc::new(RwLock::new(std::collections::HashMap::new())),
```

- [ ] **Step 2: mcp_client/mod.rs**

```rust
//! 上游 MCP server 的 client 连接管理（stdio + streamable-http）。

use rmcp::model::ClientInfo;
use rmcp::service::RunningService;
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::transport::StreamableHttpTransport;
use rmcp::RoleClient;
use std::time::Duration;

/// 解析 server_config JSON 并启动连接，返回保持连接的后台 task（abort 即断开）。
pub fn spawn_connection(
    server_config: &serde_json::Value,
    name: &str,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let typ = server_config.get("type").and_then(|t| t.as_str()).unwrap_or("stdio");
    let config = server_config.clone();
    let name = name.to_string();
    match typ {
        "http" | "sse" => {
            let url = config.get("url").and_then(|u| u.as_str())
                .ok_or_else(|| "http 类型需要 url".to_string())?
                .to_string();
            let headers = config.get("headers").cloned().unwrap_or(serde_json::json!({}));
            Ok(tokio::spawn(async move {
                // 超时握手：连接失败仅 log，task 退出（状态由调用方负责）
                let handle = tokio::time::timeout(Duration::from_secs(5), async move {
                    let transport = StreamableHttpTransport::new_simple(url);
                    // headers 注入由实现处理（rmcp 3.1.2 new(client, config) 或扩展）
                    rmcp::service::serve_client(ClientInfo::default(), transport).await
                }).await;
                match handle {
                    Ok(Ok(running)) => {
                        log::info!("MCP {name} http connected");
                        let _ = running.wait_shutdown().await;
                    }
                    _ => log::error!("MCP {name} http connect failed"),
                }
            }))
        }
        _ => {
            let command = config.get("command").and_then(|c| c.as_str())
                .ok_or_else(|| "stdio 类型需要 command".to_string())?;
            let args: Vec<String> = config.get("args").and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let env = config.get("env").cloned().unwrap_or(serde_json::json!({}));
            Ok(tokio::spawn(async move {
                let cmd = std::process::Command::new(command);
                let mut cmd = cmd;
                cmd.args(&args);
                for (k, v) in env.as_object().map(|o| o.iter()).unwrap_or_default() {
                    if let Some(vs) = v.as_str() { cmd.env(k, vs); }
                }
                let proc_res = TokioChildProcess::builder(cmd).spawn();
                let connect = async {
                    let (proc, _stderr) = proc_res?;
                    rmcp::service::serve_client(ClientInfo::default(), proc).await
                };
                match tokio::time::timeout(Duration::from_secs(5), connect).await {
                    Ok(Ok(running)) => {
                        log::info!("MCP {name} stdio connected");
                        let _ = running.wait_shutdown().await;
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
    // 等 1.5s 看 task 是否存活（存活=握手成功）
    tokio::time::sleep(Duration::from_millis(1500)).await;
    if handle.is_finished() {
        Err("连接失败（握手未完成）".to_string())
    } else {
        handle.abort();
        Ok("连接成功".to_string())
    }
}
```
注意：rmcp 3.1.2 的 `StreamableHttpTransport` 构造与 `RunningService::wait_shutdown` 的确切签名可能与本示例有出入——implementer 以实际编译为准调整（这是计划内允许的适配点，行为目标：连接建立后保持、可 abort 断开）。

- [ ] **Step 3: commands/mcp_server.rs**

- `list_mcp_servers`：`Vec<McpServer>` + 附 `connected`（`mcp_clients` 含该 id 且 handle 未结束）。返回 `Vec<McpServerStatus>`（`{ server: McpServer, connected: bool }`）或扩展模型——用 `Vec<McpServerView>`。
- `upsert_mcp_server`：校验 `validate_server_spec`（stdio 需 command / http 需 url；`directory` 无此概念）。
- `delete_mcp_server`：`disconnect` 后删。
- `toggle_mcp_server_enabled`：enabled → `connect_mcp_server`，false → `disconnect_mcp_server`，然后 `set_mcp_server_enabled`。
- `connect_mcp_server`：`spawn_connection(config)` → 存 `mcp_clients[id]`。
- `disconnect_mcp_server`：`mcp_clients.remove(id)` → abort handle。
- `test_mcp_connection`：`mcp_client::test_connection(&server_config)`。

- [ ] **Step 4: 单测**

- `upsert_rejects_stdio_without_command` / `upsert_rejects_http_without_url`。
- `toggle_enabled_state_sync`（临时目录 + mock config → toggle → DB enabled 翻转）。
- `test_connection_invalid_config_errors`（无 command/url → Err）。
- 真连接测试（stdio 本地脚本 / http mock）标 `#[ignore]`（可选，不强制）——因环境不确定，命令级状态同步测试为准。

- [ ] **Step 5: 运行验证 + Commit**

`cargo test --lib commands::mcp_server` + `cargo test --lib` + `cargo check`（重点确认 rmcp features 合并编译通过）。commit `feat(mcp): 上游 MCP server 命令+client 连接(stdio/http)`。

---

### Task 7: MCP 服务器管理前端

**Files:**
- Create: `src/pages/McpServersPage.tsx`
- Modify: `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/api.ts`, `src/types/index.ts`
- Create: `src/pages/__tests__/McpServersPage.test.tsx`
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.listMcpServers()`（含 connected）、`api.upsertMcpServer(server)`、`api.deleteMcpServer(id)`、`api.toggleMcpServerEnabled(id, enabled)`、`api.testMcpConnection(id)`、`api.connectMcpServer(id)`、`api.disconnectMcpServer(id)`。

- [ ] **Step 1: types + api**

`McpServer { id, name, server_config: any, description: string|null, enabled, created_at, updated_at }`、`McpServerView { server: McpServer; connected: boolean }`。api 7 个 wrapper。

- [ ] **Step 2: McpServersPage**

PageHeader("MCP 服务器" + 描述"管理上游 MCP server，启用/连接即启动 client 握手")。Card 列表：每行 name + description + type badge（stdio/http from server_config.type）+ `enabled` Switch + connected 徽标（绿圆点"已连接"/灰"未连接"）+ 操作（编辑/测试/连接/断开/删除）。新增/编辑 Dialog：type Select（stdio/http）+ 条件字段——stdio: command Input + args 动态列表（+ 添加/删除）+ env 键值对（KEY=VALUE 行，可增删）；http: url Input + headers 键值对。构建 `server_config` JSON。测试按钮 `testMcpConnection` → toast。删除 ConfirmDialog。

- [ ] **Step 3: App.tsx + Layout.tsx**

route `/mcp-servers` + nav `{ to: "/mcp-servers", label: "MCP", icon: Cable }`（lucide `Cable`）。

- [ ] **Step 4: 测试**

mock api：列表 + connected 徽标渲染；新增 stdio → 填 command/args → `upsertMcpServer` 参数含正确 server_config；启用 → `toggleMcpServerEnabled`；测试 → `testMcpConnection`。

- [ ] **Step 5: 运行验证 + Commit**

commit `feat(ui): MCP 服务器管理页(Wizard 表单+连接状态)`。

---

### Task 8: Skills 命令（CRUD + 目录同步）

**Files:**
- Create: `src-tauri/src/commands/skill.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Test: `cargo test --lib commands::skill`

**Interfaces:**
- Consumes: `Repository::{list_skills, get_skill, upsert_skill, delete_skill, set_skill_enabled}`、`cli_config::backup_and_write`。
- Produces: `list_skills(state) -> Vec<SkillView>`（`{ skill: Skill, synced: bool }`）、`upsert_skill`、`delete_skill`、`toggle_skill_enabled`。前端 api `listSkills` / `upsertSkill` / `deleteSkill` / `toggleSkillEnabled`。

- [ ] **Step 1: 命令实现**

写盘辅助：
```rust
const SKILL_DIR_RE: &str = r"^[A-Za-z0-9_-]+$";
fn skills_root(home: &Path) -> PathBuf { home.join(".claude").join("skills") }
fn skill_path(home: &Path, directory: &str) -> PathBuf { skills_root(home).join(directory).join("SKILL.md") }

pub(crate) fn toggle_skill_enabled_with_home(state: &AppState, home: &Path, id: &str, enabled: bool) -> Result<(), String> {
    let skill = state.repo.get_skill(id).map_err(|e| e.to_string())?
        .ok_or_else(|| "skill not found".to_string())?;
    if !regex::Regex::new(SKILL_DIR_RE).unwrap().is_match(&skill.directory) {
        return Err("目录名仅允许字母数字_-".into());
    }
    state.repo.set_skill_enabled(id, enabled).map_err(|e| e.to_string())?;
    let path = skill_path(home, &skill.directory);
    let res = if enabled {
        crate::cli_config::backup_and_write(&path, &skill.content)
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("删除 {}: {}", path.display(), e)),
        }
    };
    if let Err(e) = res {
        state.repo.set_skill_enabled(id, !enabled).ok();
        return Err(e);
    }
    Ok(())
}
```
`list_skills` 返回 `Vec<SkillView>`，`synced = 目标文件存在`。命令薄包装 + `_with_home` 辅助。校验：directory 白名单、content 非空。

- [ ] **Step 2: 单测**

- `upsert_rejects_bad_directory`（`../evil` → Err）
- `toggle_enabled_writes_and_syncs`（tempdir → enable → `~/.claude/skills/myskill/SKILL.md` 内容匹配 → synced=true → disable → 文件删除）
- `toggle_disabled_removes_file`
- `list_marks_synced`

- [ ] **Step 3: 运行验证 + Commit**

commit `feat(skill): Skills CRUD+目录同步(~/.claude/skills)`。

---

### Task 9: Skills 前端页面 + 导航

**Files:**
- Create: `src/pages/SkillsPage.tsx`
- Modify: `src/App.tsx`, `src/components/Layout.tsx`, `src/lib/api.ts`, `src/types/index.ts`
- Create: `src/pages/__tests__/SkillsPage.test.tsx`
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.listSkills()`（含 synced）、`api.upsertSkill(skill)`、`api.deleteSkill(id)`、`api.toggleSkillEnabled(id, enabled)`。

- [ ] **Step 1: types + api**

`Skill { id, name, description, directory, content, enabled, created_at, updated_at }`、`SkillView { skill: Skill; synced: boolean }`。api 4 个 wrapper。

- [ ] **Step 2: SkillsPage**

PageHeader("Skills 管理" + 描述"本地 skills 库，启用后写入 ~/.claude/skills/<目录>/SKILL.md（自动备份）")。Card 列表：每行 name + description + directory badge + `synced` 徽标（已同步/未同步）+ `enabled` Switch（→ `toggleSkillEnabled`）+ 编辑/删除（ConfirmDialog）。新增/编辑 Dialog：name/description/directory Input + content textarea（`min-h-[320px] font-mono`）+ 保存。EmptyState。

- [ ] **Step 3: App.tsx + Layout.tsx**

route `/skills` + nav `{ to: "/skills", label: "Skills", icon: Sparkles }`（lucide）。

- [ ] **Step 4: 测试**

mock api：列表 + synced 徽标；新增 → 填字段 → `upsertSkill` 参数正确；启用 → `toggleSkillEnabled`。

- [ ] **Step 5: 运行验证 + Commit**

commit `feat(ui): Skills 管理页 + 导航`。

---

## 验收

- `cargo test --lib` 全绿（318+ 现有 + 新增 prompt/session/mcp/skill 测试）。
- `pnpm typecheck` + `pnpm test:unit` 全绿（107+ 现有 + 4 页测试）。
- `cargo check` 确认 rmcp features 合并编译通过。
- `pnpm dev` 手动验证（可选）：4 个新页面可导航、CRUD 生效、Prompt 启用写 ~/.claude/CLAUDE.md（备份）、MCP 连接状态、Skills 目录同步。
