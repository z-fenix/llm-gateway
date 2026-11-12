# 设计：合并页 tab 通栏化、项目维度、图片模型角色

- 日期：2026-08-26
- 目标仓库：`C:\Users\Administrator\workplace\project\tools\llm-gateway`
- 参照仓库（只读参考）：`C:\Users\Administrator\workplace\project\tools\cc-switch`

## 背景与目标

llm-gateway 是参照 cc-switch 的本地 LLM 网关。`docs/feature.md` 剩余的待办 + 一项 UI 对齐需求：

1. **合并页 tab 通栏化**：`RecordsPage`（日志/会话）、`ResourcesPage`（知识库/Prompt/MCP/Skills）的 tab 标签，完全采用 cc-switch 的 tab 布局与样式。
2. **项目维度**：按项目（本地编码工具的 cwd）关联总览/统计、资源分项目/全局、日志/会话绑定项目。项目身份由本地编码工具自动维护。
3. **图片模型角色**：请求含图片（图像识别）或模型返回「不支持图像」时，自动路由到配置的视觉模型。

## 已确认的设计决策

- **项目标识**：使用 CLI 会话的 `cwd`（`SessionMeta.projectDir`，绝对路径字符串）作为项目键；展示取 basename。与 cc-switch 的 `projectDir` 一致，无 git 依赖。
- **项目级资源持久化**：仅存于 llm-gateway 自己的 SQLite（带 `project_dir` 列），**不同步** `$HOME/.claude/*`；选中项目时才展示/生效。

---

## 子项目 A — 合并页 tab 通栏化（对齐 cc-switch）

### 现状
两个合并页用自定义 `<div class="sticky top-0 ... flex gap-1 rounded-xl border bg-card p-1">` + `<button>`（active=`bg-primary text-primary-foreground`）。已在上一次改动中移除 `w-fit` 使其通栏，但仍为自定义样式。

### 方案
1. **新增 `src/components/ui/tabs.tsx`**：移植 cc-switch 的 Radix Tabs 组件（`@radix-ui/react-tabs`），保持其样式类（`TabsList` 灰色胶囊、`TabsTrigger` 蓝底白字 active + 灰字 inactive、`min-w-[120px]`）。颜色走 llm-gateway 现有 Tailwind 主题（`blue-500` 若未定义则在其 `tailwind.config.cjs` 的 `colors` 中补充 `#0A84FF` 等）。
2. **改造 `RecordsPage.tsx` / `ResourcesPage.tsx`**：
   - 用 `<Tabs>` 包裹；`<TabsList className="grid w-full grid-cols-N mb-6 glass rounded-lg">`（全宽等分、无外边框、玻璃底）；`<TabsTrigger>` 各标签；`<TabsContent className="mt-0">`。
   - **保留固定头部（对齐 cc-switch 布局）**：复刻 cc-switch 的「tab 置顶 + 内容独立滚动」——页面根 `flex flex-col h-full min-h-0 overflow-hidden`，`TabsList` 固定在上，`TabsContent` 内容放 `flex-1 min-h-0 overflow-y-auto`，使 `main` 不随内容滚动、tab 始终可见。若实现时发现与内层页面自带的滚动/分组视图（如 LogsPage「按会话分组」）冲突，则退化为 `sticky top-0 z-10` 包裹 `TabsList` 的方案（同为「固定头部"），以降低回归风险。
   - RecordsPage 保留其 URL 查询驱动（`?tab=`）；ResourcesPage 保留 `useState`。
3. 同步更新相关测试（`RecordsPage.test.tsx` 若对 tab 类名有断言）。

### 影响文件
- 新增：`src/components/ui/tabs.tsx`、可能 `src/lib/utils.ts`（已有 `cn`）无需改。
- 改：`src/pages/RecordsPage.tsx`、`src/pages/ResourcesPage.tsx`、`src/pages/__tests__/RecordsPage.test.tsx`、`src/pages/__tests__/ResourcesPage.test.tsx`(若无则补)、`tailwind.config.cjs`（补蓝色）。

---

## 子项目 B — 项目维度

### 数据层
- **迁移 `015_project_dir.sql`**（追加到 `src-tauri/src/db/mod.rs` 的 `MIGRATIONS` 数组末尾，注意当前到 `014`）：
  - `ALTER TABLE request_logs ADD COLUMN project_dir TEXT;`（可空）
  - `ALTER TABLE prompts ADD COLUMN project_dir TEXT;`
  - `ALTER TABLE skills ADD COLUMN project_dir TEXT;`
  - `ALTER TABLE knowledge_bases ADD COLUMN project_dir TEXT;`
  - `ALTER TABLE mcp_servers ADD COLUMN project_dir TEXT;`
  - （`project_dir` 为 NULL = 全局）
- Rust 结构体 `db/models.rs`：`RequestLog`、`Prompt`、`Skill`、`KnowledgeBase`、`McpServer` 各加 `project_dir: Option<String>`；仓库插入/读取同步。

### 日志 → 项目绑定
- 扩展 `session_manager/mod.rs::resolve_log_session`：当前返回 `(Option<session_id>, Option<session_provider>)`，改为一并返回匹配会话的 `project_dir`（`Option<String>`）。
- 在三个 `insert_log` 调用点（`proxy/handlers.rs` 约 622/714/889 行）与 `proxy/security_hook.rs`（约 93-140 行）把 `project_dir` 写入 `RequestLog`。
- 项目身份即会话 `cwd`；无会话命中时 `project_dir = None`（视为全局/未识别）。

### 筛选/统计
- `LogFilter`（`db/repository.rs` 36-48）+ `build_where`（115-172）加 `project_dir`。
- `CommandLogFilter`（`commands/log.rs` 9-23）加 `project_dir`。
- `get_stats`（`commands/stats.rs`）增加可选 `project_dir` 参数，`repo.stats()` 加过滤；`get_log_timeseries`/`get_log_stats` 已接受 filter，透传 `project_dir`。
- `src/lib/api.ts`：`getStats`、`getLogTimeseries`、`getLogStats`、`listLogs` 等加 `project_dir` 实参；`src/types/index.ts` 的 `LogFilter`、`Stats` 相应字段。

### UI
- **总览（DashboardPage）**：新增**项目选择器**（下拉/列表，来源 = 扫描会话的 `project_dir` 去重），选中后 `getStats`/`getLogTimeseries`/`getLogStats` 按项目过滤；`UsageDateRangePicker` 沿用。
- **日志/会话（LogsPage/RecordsPage）**：`LogsPage` 加项目筛选下拉；列表显示项目列；`SessionsPage` 已按 `projectDir` 分组（复用）。
- **资源页（Knowledge/Prompts/Skills/McpServers）**：加「全局 / 当前项目」范围切换；`project_dir` 为空为全局。创建/编辑表单增加「作用范围（全局/当前项目）」，当前项目来自全局选中的项目（或页内选择）。
- 全局项目选择器状态：放入 **zustand store**（repo 已用 zustand，如 `src/lib/api.ts` 之外独立一个 `src/lib/projectStore.ts`）或 `App` 级 context，供 Dashboard/Logs/资源页多处读取。

### 生效机制（仅存 DB）
项目级资源**不同步** `~/.claude`。对 prompt：当启用的项目级 prompt 命中当前项目时，由网关在请求注入阶段（如现有 prompt/RAG 注入处）按项目叠加注入；kb/mcp/skills 同理按当前项目启用。全局资源行为不变。

### 影响文件（代表性）
`src-tauri/migrations/015_project_dir.sql`、`src-tauri/src/db/mod.rs`、`src-tauri/src/db/models.rs`、`src-tauri/src/db/repository.rs`、`src-tauri/src/session_manager/mod.rs`、`src-tauri/src/proxy/handlers.rs`、`src-tauri/src/proxy/security_hook.rs`、`src-tauri/src/commands/{stats,log,prompt,skill,knowledge,mcp_server}.rs`、`src/lib/api.ts`、`src/types/index.ts`、`src/pages/{DashboardPage,LogsPage,KnowledgePage,PromptsPage,SkillsPage,McpServersPage}.tsx`、新增 `src/lib/projectStore.ts`、新增 `src/components/ProjectPicker.tsx`。

---

## 子项目 C — 图片模型角色

### 概念
新增合成角色 `image`（类似现有 `auto`），无需改 schema。配置在 `role_routes` 的 `role='image'` 下（渠道+模型）。前端 `ROLE_ORDER`/`ROLE_COLORS`（`src/lib/roleSort.ts`、`RoleRoutesPage.tsx`）加入 `image`。

### 请求侧（预路由）
- 新增 `router::role::is_image_request(chat: &ChatRequest) -> bool`：遍历 `chat.messages[].content`（`serde_json::Value`），检测
  - Anthropic/Gemini 风格：content 数组块 `type == "image"`；
  - OpenAI 风格：content 数组块 `type == "image_url"`（或含 `image_url` 对象）；
  - 工具消息中的 `input_image` 等（可后置）。
- 在 `handlers.rs` 约 335-341：`let role = detect_role(...).or(if is_image_request { Some("image") })...`。即「模型名命中角色 → 否则若含图 → image → 否则 auto」。

### 错误侧（重路由）
- 复刻 cc-switch 的 `media_retry_should_trigger`：在 `proxy/forwarder.rs` 的错误循环中，若上游返回 400/415/422/501 且 body 命中「不支持图像」（`[Unsupported Image]`/`not supported`/`does not support` 等 + image 关键词），当前逻辑在 4xx 直接 abort；改为：若尚无 image 角色尝试，则按 `image` 角色重新 `build_candidates` 再试一次（不无限重试）。

### 视觉能力启发式
- 复用/扩展 `proxy/rectifier/media.rs::is_text_only_model` 判断途经模型是否图像能力未知；已知支持图像则无需重路由。可参考 cc-switch 的 `resolve_image_input_capability`（声明优先，失败开放）。

### 协议注意
- 现有 Responses/Gemini 的 `request_to_chat` 会**丢弃** image 块；为使 `is_image_request` 对这些协议也生效，需让它们在统一 `ChatMessage.content` 中保留 image 块（透传），上游构造相应保留 → 同时让 `build_upstream_body`/`adapter` 对 Gemini/Responses 透传 image。

### 影响文件（代表性）
`src-tauri/src/router/role.rs`、`src-tauri/src/protocol/types.rs`、`src-tauri/src/protocol/{responses,gemini}.rs`、`src-tauri/src/proxy/handlers.rs`、`src-tauri/src/proxy/forwarder.rs`、`src-tauri/src/proxy/rectifier/media.rs`、`src-tauri/src/provider/adapter.rs`、`src/lib/roleSort.ts`、`src/pages/RoleRoutesPage.tsx`、`src/types/index.ts`。

---

## 测试与验证
- Rust：`cargo test --lib` 新增用例（`parse_models_response` 等已有；补 `is_image_request`、`resolve_log_session` 扩展、`build_where`/`stats` 按项目过滤、forwarder 图片重路由）。`cargo test --no-run` 保编译。
- 前端：`pnpm test:unit` 更新既有断言（tab 类名、新增项目筛选、图片角色 UI）；`pnpm typecheck`；`pnpm build:renderer`。
- 手动（`pnpm dev`）：确认 tab 通栏 + 蓝高亮 + 固定头部；项目选择器过滤总览/日志；资源页全局/项目切换；发送含图请求观察路由到 image 角色、以及模型返回不支持时重路由。

## 建议执行顺序
A（tab，小、独立）→ B（项目维度，最大）→ C（图片角色，中，但需协议改动）。
