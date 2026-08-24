# 实施计划：功能补全 + UI cc-switch 化改造

> 依据: `docs/superpowers/specs/2026-08-22-llm-gateway-feature-completion-ui-refactor-design.md`
> 策略: A（后端补全 → UI 基础设施 → 页面改造）；保留 React Router。

## Global Constraints

- 所有后端命令必须注册到 `src-tauri/src/lib.rs` 的 `invoke_handler!` 并在 `src/lib/api.ts` 提供包装。
- IPC 参数键一律 camelCase（对齐 Tauri command 默认匹配约定）。
- 请求/响应日志 body 必须经 `security::redact::redact_json_for_logging` 脱敏；`request_logs` 永不存裸 API key。
- 每个新增命令需带单元测试；集成改动需 `cargo test` 全量通过，前端改动需 `pnpm typecheck` + `pnpm test:unit` 通过。
- UI 采用 cc-switch 视觉（shadcn default 变量、`rounded-xl border bg-card`、蓝色 primary、emerald switch、sonner toast、ConfirmDialog、空状态）。
- 不改网关核心请求管线（auth → 协议转换 → RAG → 安检 → 路由 → 转发 → 日志）。
- 不替换 `react-router-dom`。

## Task 1: 渠道模型映射命令 ✅ DONE

实现 `set_model_map` / `delete_model_map` / `get_model_map` 命令、注册、前端 API 与单元测试。
- Commit: `3682b1d`
- Brief: `.superpowers/sdd/2026-08-22-llm-gateway-feature-completion-ui-refactor/task-1-brief.md`

## Task 2: API Key 重命名与编辑 ✅ DONE

实现 `update_api_key(id, name, quota_total)` 命令、注册、前端 API 与单元测试。
- Commit: `1c81dfe`
- Brief: `.superpowers/sdd/2026-08-22-llm-gateway-feature-completion-ui-refactor/task-2-brief.md`

## Task 3: 知识库启用/禁用与编辑（进行中）

实现 `set_kb_status` / `rename_kb` / `update_kb_embedding_channel` 命令、`006_kb_needs_reindex.sql` 迁移、仓库层 `rename_kb` / `update_kb_embedding_channel`、注册、前端 API 与单元测试。

- Brief: `.superpowers/sdd/2026-08-22-llm-gateway-feature-completion-ui-refactor/task-3-brief.md`
- 状态: 代码已在工作树实现，未提交、未写报告。需验证测试 → commit → 写报告 → task review。

**Files:**
- Modify: `src-tauri/src/commands/knowledge.rs`
- Modify: `src-tauri/src/db/mod.rs`（注册 006 迁移）
- Modify: `src-tauri/src/db/models.rs`（needs_reindex 语义更新）
- Modify: `src-tauri/src/db/repository.rs`（rename_kb / update_kb_embedding_channel / needs_reindex 落库）
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`
- Add: `src-tauri/migrations/006_kb_needs_reindex.sql`
- Test: `cargo test --lib knowledge`

## Task 4: 渠道表单校验

**Files:**
- Modify: `src-tauri/src/commands/channel.rs`（create/update 校验 name/base_url/api_key/models/timeout）
- Modify: `src/components/ChannelForm.tsx`（前端必填校验 + 错误提示）
- Test: `cargo test --lib channel` + `pnpm test:unit`

**校验规则:**
- name 非空；base_url 非空且可解析为 URL（http/https）；api_key 非空；models 至少 1 个；timeout_secs ≥ 1。
- 前端与后端同一套规则，后端为准。

## Task 5: 自定义安全规则 action 执行

**Files:**
- Modify: `src-tauri/src/security/rules.rs`（返回规则自身的 action 候选）
- Modify: `src-tauri/src/security/mod.rs` 或 `src-tauri/src/proxy/security_hook.rs`（decide_action 结合规则 action 与全局 mode，取较严）
- Modify: `src/pages/SecurityPage.tsx`（动作字段说明：规则 action 与全局模式取严）
- Test: `cargo test --lib security`

**规则:**
- 触发自定义规则且该规则带 `action`（block/redact/warn）时，最终 action = max(全局 mode action, 规则 action)（按 Allow<Warn<Redact<Block 排序）。
- 仅当自定义规则命中其 pattern 时才应用该规则 action。

## Task 6: 端口变更重启流程

**Files:**
- Modify: `src-tauri/src/proxy/state.rs`（AppState 增 `gateway_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>`）
- Modify: `src-tauri/src/lib.rs`（启动后将 handle 存入 state）
- Modify: `src-tauri/src/commands/config.rs`（新增 `restart_gateway()` 命令）
- Modify: `src/pages/SettingsPage.tsx`（保存端口后显示“立即重启”按钮 + loading）
- Modify: `src/lib/api.ts`、`src/types/index.ts`（如需）
- Test: 单元测试（AppState handle 存在性）；集成验证（重启后新端口可访问）

**规则:**
- `restart_gateway()`: abort 旧 handle，用当前 `preferred_port` 重新 `server::start`，更新 `bound_addr` 与 `gateway_handle`。
- 新服务启动失败时返回错误，保留旧状态。

## Task 7: Gemini Native 流式修复

**Files:**
- Modify: `src-tauri/src/proxy/sse.rs`（新增 `Protocol::GeminiNative`，解析 `data: {...}` newline-delimited JSON，提取 `candidates[0].content.parts[].text` 与 `usageMetadata` token）
- Modify: `src-tauri/src/proxy/forwarder.rs`（`gemini-native` 分支使用新 protocol）
- Test: `src-tauri/tests/` 新增 Gemini 流式集成测试（mock 返回 Gemini 风格的流式分块），验证文本与 usage 提取。

## Task 8: UI 基础设施（shadcn 化）

**Files:**
- Modify: `src/index.css`（cc-switch 设计变量）
- Modify: `tailwind.config.cjs`（hsl(var(--name)) 映射）
- Modify: `src/components/Layout.tsx`（固定 header、muted pill 导航、active blue）
- Add: `src/components/ui/{card,button,dialog,input,switch,badge,label,select,accordion,sonner}.tsx`
- Add: `src/components/ConfirmDialog.tsx`、`src/components/EmptyState.tsx`、`src/components/LoadingState.tsx`、`src/components/PageHeader.tsx`
- Add: `src/lib/utils.ts`（cn helper）若缺
- Test: `pnpm typecheck` + `pnpm test:unit`

**依赖:** 安装 `class-variance-authority`, `clsx`, `tailwind-merge`, `sonner`, `@radix-ui/react-dialog`, `@radix-ui/react-select`, `@radix-ui/react-switch`, `@radix-ui/react-accordion`, `@radix-ui/react-label`。

## Task 9: Dashboard + Channels 页面改造（含模型映射 UI）

**Files:**
- Modify: `src/pages/DashboardPage.tsx`（统计卡片 + 趋势图 card 化 + 空状态）
- Modify: `src/pages/ChannelsPage.tsx`（卡片/表格 card 化、hover 操作、新建/编辑对话框、模型映射折叠面板）
- Modify: `src/components/ChannelForm.tsx`（shadcn 表单 + 模型映射 UI + Task 4 校验）
- Test: `pnpm test:unit` + `pnpm typecheck`

## Task 10: API Keys + Role Routes 页面改造

**Files:**
- Modify: `src/pages/ApiKeysPage.tsx`（卡片化、重命名/配额对话框、key 复制、启用 switch、空状态）
- Modify: `src/pages/RoleRoutesPage.tsx`（路由表格卡片化、角色规则新增/编辑对话框、全局兜底卡片、空状态）
- Test: `pnpm test:unit` + `pnpm typecheck`

## Task 11: Security + Logs 页面改造（含按会话查看日志）

**Files:**
- Modify: `src/pages/SecurityPage.tsx`（设置卡片化、规则表格 card 化、自定义规则 action 说明）
- Modify: `src/pages/LogsPage.tsx`（过滤工具栏 muted pill、表格卡片化、完整日期时间、按会话分组视图）
- Test: `pnpm test:unit` + `pnpm typecheck`

**日志按会话:**
- 平铺列表（现有）+ “按会话分组”标签页。
- 分组键：`trace_id`（展开显示该 trace 全部日志）。
- 空状态与加载状态组件化。

## Task 12: Knowledge + Settings 页面改造

**Files:**
- Modify: `src/pages/KnowledgePage.tsx`（KB 卡片列表、启用 switch、编辑对话框、文档列表 card/table、空状态、文件大小人类可读）
- Modify: `src/pages/SettingsPage.tsx`（分组卡片、端口保存+重启按钮、CLI 写入卡片、导入导出卡片、CLI target 友好标签）
- Test: `pnpm test:unit` + `pnpm typecheck`

## 验收

- `cargo test`（src-tauri/）全量通过。
- `pnpm typecheck` + `pnpm test:unit` 通过。
- `pnpm dev` 手动验证：模型映射生效、角色规则增改、KB 编辑/重建、端口重启、日志按会话分组、各页面 cc-switch 风格。
