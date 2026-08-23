# LLM Gateway 阶段：会话 / Skills / Prompt / MCP 服务器管理 设计

> 日期: 2026-08-23
> 前置: 阶段「整流器+趋势+CLI+模型表单」已合并（commit 13a9d7c）。
> 需求来源: `docs/feature.md` — 添加 cc-switch 的 `会话管理` `Skills 管理` `prompt 管理` `MCP 服务器管理`。

## 1. 目标与非目标

**目标**
1. **Prompt 管理**：多套 CLAUDE.md 模板的编辑器——`prompts` 表 + CRUD + 启用互斥（一次仅一个 enabled），启用时把 content 原子写盘到 `~/.claude/CLAUDE.md`（先备份原文件）。
2. **会话管理**：将 `request_logs.trace_id` 分组提升为独立主从页——`list_sessions`（GROUP BY trace_id 聚合）+ `get_session_messages(trace_id)`，前端主从布局 + 搜索。
3. **MCP 服务器管理**：管理上游 MCP server 列表 + **真实 client 连接**——`mcp_servers` 表 + CRUD + `test_connection`/`connect`/`disconnect`，用 rmcp client（stdio child-process + streamable-http reqwest）。
4. **Skills 管理**：本地 skills 库 + 目录同步——`skills` 表 + CRUD + 启用时写入 `~/.claude/skills/<directory>/SKILL.md`（先备份）。

**非目标**
- 不做 MCP 上游工具的自动发现/代理到网关（本阶段只建立 client 连接与管理列表，不把上游 MCP 工具合并进 `/mcp` 知识库工具集）。
- 不做 Skills 的 GitHub 仓库发现 / skills.sh 搜索 / 更新检测 / 多 CLI 同步（仅 Claude Code 目录）。
- 不做会话的虚拟滚动 / FlexSearch（llm-gateway 消息量来自网关日志，量远小于外部 CLI 全历史，前端 filter 足够）。
- 不改网关核心请求管线（auth → 协议转换 → RAG → 安检 → 路由 → 转发 → 日志）。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 范围 | 4 项全做（一个阶段、单 spec / 单 plan） |
| MCP 语义 | 真实 client 连接：`test_connection`/`connect`/`disconnect` + 状态；启用 = 网关内启动 client |
| MCP 传输 | stdio（child-process）+ streamable-http（reqwest）都支持 |
| Skills 形态 | 本地库 + 目录同步（启用=写入 `~/.claude/skills/<directory>/SKILL.md`） |
| Prompt 写盘目标 | 默认 `~/.claude/CLAUDE.md`（启用互斥，写前备份原文件为 `CLAUDE.md.bak-{ts}`） |
| Skills 目录目标 | 默认 `~/.claude/skills/` |
| UI 入口 | 4 个新页面加到左侧导航（`/prompts` `/sessions` `/mcp-servers` `/skills`），现有 8 页不动 |

## 3. 模块划分（贴合现有分层）

### 3.1 Prompt 管理（最易，全搬 cc-switch 模式）

**新表** `prompts`（迁移 `007_prompts.sql`）：
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

**仓库层** `db/repository.rs` 增：`list_prompts()` / `get_prompt(id)` / `upsert_prompt(p)` / `delete_prompt(id)` / `set_prompt_enabled(id, enabled)`（启用互斥：`UPDATE prompts SET enabled=0` 后 `UPDATE ... SET enabled=1`，事务或顺序执行）。

**命令** `src-tauri/src/commands/prompt.rs`：
- `list_prompts(state) -> Vec<Prompt>`
- `upsert_prompt(state, id: Option<String>, name, content, description) -> Prompt`（id 空则生成 uuid；name/content 非空校验）
- `delete_prompt(state, id)`（已启用者拒绝删，返回错误）
- `enable_prompt(state, id)`（先 `set_prompt_enabled(id, true)` 互斥，再读 content 写盘 `~/.claude/CLAUDE.md`：存在则备份为 `CLAUDE.md.bak-{ts}`，然后 `backup_and_write` 写新内容；写盘失败则回滚 enabled）
- `get_enabled_prompt(state) -> Option<Prompt>`

**模型** `db/models.rs` 增 `Prompt { id, name, content, description: Option<String>, enabled: bool, created_at, updated_at }`。

**前端** `src/pages/PromptsPage.tsx`：PageHeader + Card 列表（每行名称/描述/启用 Switch + 编辑/删除）+ 新增/编辑 Dialog（name/description Input + content textarea `min-h-[320px] font-mono` + 保存）+ 启用互斥（点击启用某条，其它自动关）+ 删除 ConfirmDialog + EmptyState。启用成功后 toast 提示"已写入 ~/.claude/CLAUDE.md"。

**类型** `types/index.ts` 增 `Prompt`；`api.ts` 增 5 个 wrapper。

### 3.2 会话管理（数据现成，重做前端）

**命令** `src-tauri/src/commands/session.rs`：
- `list_sessions(state) -> Vec<SessionMeta>`：`SELECT trace_id, MAX(created_at) AS last_active, COUNT(*) AS message_count, MIN(created_at) AS first_active FROM request_logs GROUP BY trace_id ORDER BY last_active DESC`；title 从该 trace 首条 user 请求的 request_body 提取（解析 messages[0].content 截断 80 字符），角色分布 `GROUP BY trace_id, role`。
- `get_session_messages(state, trace_id) -> Vec<SessionMessage>`：`SELECT seq, role, request_model, status_code, created_at, request_body, response_body, error, tool_calls FROM request_logs WHERE trace_id=? ORDER BY seq`；映射 `SessionMessage { seq, role, content(首条 user 消息或 response content 摘要), status_code, created_at, error }`。
- `delete_session(state, trace_id)`：先删该 trace 的 `request_security_findings`（`WHERE log_id IN (SELECT id FROM request_logs WHERE trace_id=?)`），再删 `request_logs WHERE trace_id=?`，返回删除行数。

**模型**：
```rust
pub struct SessionMeta { pub trace_id: String, pub title: Option<String>, pub first_active: i64, pub last_active: i64, pub message_count: i64, pub roles: Vec<(String, i64)> }
pub struct SessionMessage { pub seq: i64, pub role: Option<String>, pub content: Option<String>, pub status_code: Option<i64>, pub created_at: i64, pub error: Option<String> }
```

**前端** `src/pages/SessionsPage.tsx`：主从布局 `grid md:grid-cols-[320px_1fr]`（照搬 cc-switch SessionManagerPage 骨架）——左侧 Card（会话列表 + 搜索 Input + 每行 trace_id 短码/标题/时间/消息数/角色 badge），右侧 Card（选中会话详情：头部 trace_id + 时间，消息列表每条 = role badge + content 摘要 + 展开显示 request/response body（复用 LogsPage 的 prettyJson 心智）+ 错误标记）。搜索前端 filter（trace_id/title）。空状态 EmptyState。**删除会话**：`delete_session(trace_id)`（删该 trace 的 request_logs 行并级联删其 security_findings），行内删除按钮 + ConfirmDialog。

**说明**：llm-gateway 的 request_logs 本身保留全量消息（request_body/response_body），会话消息=该 trace 的所有日志行；比 cc-switch 扫描外部 jsonl 更直接。

### 3.3 MCP 服务器管理（最难，需重设计 client 连接）

**依赖**：正式依赖 rmcp 增 features：`client`、`transport-child-process`、`transport-streamable-http-client-reqwest`（当前 client 相关在 dev-dependencies，需提升；保留 server 相关）。

**新表** `mcp_servers`（迁移 `008_mcp_servers.sql`）：
```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_config TEXT NOT NULL,  -- JSON: { type: "stdio"|"http", command?, args?, env?, url?, headers? }
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**模型** `McpServer { id, name, server_config: serde_json::Value, description: Option<String>, enabled: bool, created_at, updated_at }`。

**运行时状态**：`AppState` 增 `mcp_clients: Arc<RwLock<HashMap<String, McpClientHandle>>>`，`McpClientHandle { transport: McpTransport, started_at: i64 }`（`McpTransport` 枚举：Stdio / Http；handle 存已建立的连接句柄或 task handle）。

**命令** `src-tauri/src/commands/mcp_server.rs`：
- `list_mcp_servers(state) -> Vec<McpServer>`（附运行时连接状态：`connected: bool`，从 `state.mcp_clients` 查）
- `upsert_mcp_server(state, server)`（校验：stdio 需 command，http 需 url；生成/保留 id）
- `delete_mcp_server(state, id)`（先 disconnect 再删）
- `toggle_mcp_server_enabled(state, id, enabled)`（启用 = connect，禁用 = disconnect；表字段同步）
- `test_mcp_connection(state, id) -> Result<TestResult, String>`（临时 connect→握手→disconnect，返回 ok/latency/error）
- `connect_mcp_server(state, id)` / `disconnect_mcp_server(state, id)`（显式连接/断开，更新 `mcp_clients`）

**连接实现** `src-tauri/src/mcp_client/mod.rs`：
- `connect_stdio(config) -> Result<McpClientHandle, String>`：`rmcp::transport::child_process::TokioChildProcess` 基于 command/args/env spawn，`serve_client` 握手，返回 task handle（保持连接存活）。
- `connect_http(config) -> Result<McpClientHandle, String>`：`rmcp::transport::StreamableHttpTransport::new(url, headers)`（reqwest client），`serve_client` 握手。
- 连接失败返回错误；断开 = abort task / 关闭传输。
- **注意**：本阶段不做工具发现/代理；连接成功即保持（状态为 connected），供后续阶段扩展。

**前端** `src/pages/McpServersPage.tsx`：
- 列表 Card：每行 name/description/type badge/`enabled` Switch（启用=connect，禁用=disconnect）/连接状态徽标（绿 connected / 灰 disconnected）/操作（编辑/测试/连接/断开/删除）。
- 新增/编辑 Dialog：type 选择（stdio/http）+ 条件字段（stdio: command + args 动态列表 + env 键值对；http: url + headers 键值对），照搬 cc-switch McpWizardModal 交互（Wizard 表单，非纯 JSON 编辑）。
- 测试按钮：`test_mcp_connection` → toast 显示 ok/err。

### 3.4 Skills 管理（本地库 + 目录同步）

**新表** `skills`（迁移 `009_skills.sql`）：
```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  directory TEXT NOT NULL,   -- 目标目录名（~/.claude/skills/<directory>/ 下）
  content TEXT NOT NULL,     -- SKILL.md 全文
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**命令** `src-tauri/src/commands/skill.rs`：
- `list_skills(state) -> Vec<Skill>`（附 `synced: bool`——目标文件是否存在且内容 hash 匹配）
- `upsert_skill(state, skill)`（directory/content 非空校验；directory 防路径穿越：只允许 `[A-Za-z0-9_-]`）
- `delete_skill(state, id)`（先删目标目录文件再删记录）
- `toggle_skill_enabled(state, id, enabled)`（启用 = 写 `~/.claude/skills/<directory>/SKILL.md`（备份已有同名），禁用 = 删除目标文件；写盘失败回滚）

**模型** `Skill { id, name, description, directory, content, enabled, created_at, updated_at }`。

**前端** `src/pages/SkillsPage.tsx`：PageHeader + Card 列表（名称/描述/directory badge/`synced` 徽标/启用 Switch/编辑/删除）+ 新增/编辑 Dialog（name/description/directory Input + content textarea `min-h-[320px] font-mono`）+ 删除 ConfirmDialog + EmptyState。

## 4. 数据流与交互

1. **Prompt**：启用 → `set_prompt_enabled` 互斥 → 写 `~/.claude/CLAUDE.md`（备份）→ toast；停用/切到另一条 → 写新内容。
2. **Sessions**：SessionsPage 挂载 `list_sessions` → 点击某条 `get_session_messages(trace_id)` → 主从渲染。
3. **MCP**：启用/连接 → `connect_mcp_server` 启动 rmcp client → `mcp_clients` 记录 → 状态徽标；测试 → 临时握手。
4. **Skills**：启用 → 写 `~/.claude/skills/<dir>/SKILL.md`；禁用 → 删目标文件。

## 5. 测试计划

- **Rust**：
  - Prompt：`list/upsert/delete/enable` 单测（启用互斥、写盘备份、已启用拒绝删、写盘失败回滚）；`tempdir` 隔离 `~/.claude` 路径（用可注入 home）。
  - Sessions：`list_sessions` 聚合正确（插多条日志不同 trace 断言 meta）、`get_session_messages` 排序与映射。
  - MCP：`upsert` 校验（stdio 无 command 拒绝）、`toggle_enabled` 状态同步、`test_mcp_connection`（对本地 mock http server 或空 command 返回 err）；`connect_stdio`/`connect_http` 握手成功路径（可 mock 一个本地 stdio 脚本或 http server——若难则单测校验函数 + 命令级测试断言状态字段）。
  - Skills：`upsert` 校验（目录白名单）、`toggle_enabled` 写盘/删除目标文件（tempdir home）。
  - `cargo test --lib` 全绿（318+ 现有 + 新增）；e2e 若受本机代理影响用 `NO_PROXY=127.0.0.1,localhost`。
- **前端**：4 个页面各 + 关键交互测试（启用开关调用对应命令、表单提交、空状态）；`pnpm typecheck` + `pnpm test:unit` 全绿。
- 手动 `pnpm dev` 验证（可选）。

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 写 `~/.claude/CLAUDE.md` / `~/.claude/skills/` 覆盖用户文件 | 写前 `backup_and_write` 备份为 `.bak-{ts}`；写盘失败回滚 DB 状态 |
| MCP client 握手阻塞/挂起 | `test_mcp_connection`/`connect` 加超时（如 5s）；连接失败返回错误不清真 |
| rmcp client 依赖提升破坏现有 server | client 与 server features 兼容（rmcp 同时支持）；`cargo check` 验证 |
| Skills directory 路径穿越 | 白名单校验 `[A-Za-z0-9_-]` |
| 会话删除级联 security_findings | `delete_logs_by_trace` 先删 findings 再删 logs（或依赖现有级联） |
| 4 页导航拥挤 | 侧边栏已有多项，分组或保留现有紧凑样式 |

## 7. 交付物

- 后端：3 个迁移（007/008/009）+ `commands/{prompt, session, mcp_server, skill}.rs` + `mcp_client/` 模块 + `AppState.mcp_clients` + repository 方法。
- 前端：`PromptsPage` / `SessionsPage` / `McpServersPage` / `SkillsPage` + 导航 + api.ts + types。
- 测试：Rust 单测/集成 + 前端测试。
- 更新的 `CLAUDE.md`（新命令/模块/页面）。
