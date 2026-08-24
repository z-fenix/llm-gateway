# LLM Gateway 功能补全 + UI cc-switch 化改造 设计

> 日期: 2026-08-22  
> 方案: A（后端优先补齐，再统一 UI 改造；保留 React Router，仅采用 cc-switch 视觉与交互模式）

## 1. 目标与非目标

**目标**
1. 补全当前后端已具备数据/仓库能力但缺少命令/UI 的功能：渠道模型映射、角色规则增改、知识库启用/编辑、API Key 重命名、渠道表单校验、自定义安全规则 action 执行、端口变更重启。
2. 修复 Gemini Native 流式转发的不完整实现。
3. 将前端 UI 统一改造为 cc-switch 视觉风格：shadcn/ui default 变量体系、固定 header、卡片/空状态/对话框/Toast 组件、蓝绿中性色、hover/active 状态。

**非目标**
- 不替换 `react-router-dom` 为 view-state 路由。
- 不改网关核心请求管线（auth → 协议转换 → RAG → 安检 → 路由 → 转发 → 日志）。
- 不做暗黑模式动态切换（先保留变量体系，默认 light；后续可加 toggle）。
- 不新增上游协议类型。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 改造策略 | A：后端补全 → UI 基础（主题/布局/共享组件）→ 各页面改造 |
| 路由 | 保留 `react-router-dom`，只复用 cc-switch 视觉与组件 |
| Gemini 流式 | 本轮包含修复 |
| UI 风格来源 | `D:\workplace\project\cc-switch`：shadcn default 变量、卡片、对话框、Toast、空状态 |

## 3. 总体阶段

### Phase 1 — 后端补全
完成所有“仓库/DB 已有但命令/UI 未暴露”的功能，并修复 Gemini 流式。保证现有 UI 仍可工作。

### Phase 2 — UI 基础设施
引入 shadcn/ui 变量与基础组件，建立 cc-switch 风格的 `Layout`、Toast、ConfirmDialog、空状态、表单组件。

### Phase 3 — 页面改造
按页面逐个替换为 cc-switch 风格，并接入 Phase 1 新增的功能。

## 4. 后端补全设计

### 4.1 渠道模型映射（Channel Model Map）

**现状**
- 表 `channel_model_maps`、仓库 `Repository::set_model_map` / `get_model_map` 已存在。
- `router::dispatch` 在非角色路由时已调用 `model_map::resolve_model`，但无命令/UI。

**新增**
- `src-tauri/src/commands/channel.rs`：
  - `set_model_map(channel_id, source_model, target_model)`
  - `delete_model_map(channel_id, source_model)`
  - `get_model_map(channel_id) -> Vec<ModelMapEntry>`
- `src/lib.rs`：注册新命令。
- `src/types/index.ts`：增加 `ModelMapEntry`。
- `src/lib/api.ts`：增加调用。

**交互位置**
- `ChannelForm.tsx` 新增“模型映射”折叠面板，列出 source → target，支持增删。
- 在 `ChannelsPage` 列表中显示映射数量徽标。

### 4.2 角色规则 CRUD

**现状**
- `upsert_role_pattern` / `delete_role_pattern` 命令已存在；UI 只有列表和删除。

**新增 UI**
- `RoleRoutesPage.tsx` 顶部增加“新增规则”按钮 → 对话框表单：
  - pattern（通配，如 `*sonnet*`）
  - role（下拉：sonnet / opus / fable / haiku / auto）
  - priority（数字）
  - enabled（switch）
- 列表行支持 inline 编辑或对话框编辑。

**角色选择**
- 未匹配角色时使用 `auto` 占位（与需求一致）。`role_patterns` 可绑定到 `auto`。

### 4.3 知识库启用/禁用与编辑

**现状**
- `Repository::set_kb_status` 存在但无命令/UI；无重命名/换 embedding 渠道命令。

**新增**
- 命令：
  - `set_kb_status(id, enabled)`
  - `rename_kb(id, name)`
  - `update_kb_embedding_channel(id, channel_id, model)`（可选，若变更则标记 `needs_reindex`）
- `KnowledgePage.tsx`：每行增加启用 switch、编辑按钮（对话框：名称、embedding 渠道/模型）。

### 4.4 API Key 重命名与完整编辑

**现状**
- 仓库 `update_api_key` 存在；命令只有 enable/disable/quota/delete。

**新增**
- 命令：`update_api_key(id, name, quota_total)`（name 必填，quota_total 可 null）。
- `ApiKeysPage.tsx`：行内/对话框编辑 name 与 quota。

### 4.5 渠道表单校验

**现状**
- `ChannelForm.tsx` 提交前不校验；后端 `create_channel` 也不校验。

**改造**
- 前端校验：name、base_url、api_key、models（至少一个）必填；base_url 需合法 URL；timeout_secs ≥ 1。
- 后端 `commands/channel.rs` 增加同规则校验，返回明确错误信息。

### 4.6 自定义安全规则 action 执行

**现状**
- `CustomRule.action` 被存储但 `security/rules.rs` 只产生 finding，最终 action 由全局 mode 决定。

**改造**
- 在 `security::decide_action` 或 `security_hook` 层：若触发的自定义规则带有 `action`（block/redact/warn），则取该规则 action 与全局 mode 的较严者。
- UI `SecurityPage.tsx` 中“动作”字段保留，但增加说明：规则 action 与全局模式取严。

### 4.7 端口变更重启流程

**现状**
- 保存端口只写 store，提示“重启生效”。

**改造**
- 新增命令 `restart_gateway()`：
  - 关闭旧 `TcpListener`（通过保存 `JoinHandle` 并 abort，或新增 graceful shutdown channel）。
  - 用新 preferred port 重新 `server::start`。
  - 更新 `state.bound_addr`。
- `SettingsPage.tsx`：保存端口后显示“立即重启”按钮；重启中显示 loading。

**实现细节**
- `AppState` 增加 `gateway_handle: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>`。
- `lib.rs` 启动后将 handle 存入 state。
- `restart_gateway` 调用时：abort 旧 handle，spawn 新 runtime thread 启动新服务。

### 4.8 Gemini Native 流式修复

**现状**
- `proxy/forwarder.rs` 将 Gemini 流标记为 `Protocol::Gemini`，但 SSE 解析器按 OpenAI/Anthropic Server-Sent Events 解析。
- Gemini Native streaming 返回 newline-delimited JSON (`data: {...}`)，字段结构不同。

**改造**
- 新增 `proxy::sse::Protocol::GeminiNative`，实现 `feed_line`：
  - 解析 `data: {...}` JSON 行。
  - 提取 `candidates[0].content.parts[].text` 累加文本。
  - 提取 `usageMetadata` 中的 token 数。
- `proxy::forwarder::forward_stream` 中 `gemini-native` 分支使用新 protocol。
- 非流式 already works；流式修复后加集成测试。

## 5. UI 改造设计

### 5.1 设计系统变量

在 `src/index.css` 引入 cc-switch 的 CSS 变量：

```css
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 3.9%;
  --card: 0 0% 100%;
  --card-foreground: 240 10% 3.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 240 10% 3.9%;
  --primary: 210 100% 56%;
  --primary-foreground: 0 0% 100%;
  --secondary: 240 4.8% 95.9%;
  --secondary-foreground: 240 5.9% 10%;
  --muted: 240 4.8% 95.9%;
  --muted-foreground: 240 3.8% 46.1%;
  --accent: 240 4.8% 95.9%;
  --accent-foreground: 240 5.9% 10%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;
  --border: 240 5.9% 90%;
  --input: 240 5.9% 90%;
  --ring: 210 100% 56%;
  --radius: 0.5rem;
}
```

扩展 `tailwind.config.cjs` 映射到 `hsl(var(--name))`。

### 5.2 布局外壳

改造 `src/components/Layout.tsx`：
- 固定顶部 header：`fixed z-50 w-full h-16 bg-background/80 backdrop-blur-md border-b`。
- Header 左侧：品牌/标题；右侧：全局操作或当前页面标题（可选）。
- 保留左侧导航栏，样式改为 cc-switch 的 muted pill / active blue indicator。
- Main content：`pt-16 px-6 pb-6`。

### 5.3 共享组件

新建/改造以下组件：

| 组件 | 职责 |
|---|---|
| `src/components/ui/card.tsx` | shadcn Card（Header/Title/Description/Content/Footer） |
| `src/components/ui/button.tsx` | default / outline / ghost / destructive / secondary |
| `src/components/ui/dialog.tsx` | 对话框，阻止 backdrop 误关闭 |
| `src/components/ui/input.tsx` | rounded-md border bg-background focus:ring-blue-500/20 |
| `src/components/ui/switch.tsx` | emerald checked state |
| `src/components/ui/badge.tsx` | secondary / outline / destructive |
| `src/components/ui/sonner.tsx` | Toast provider |
| `src/components/ui/label.tsx` | 表单标签 |
| `src/components/ui/select.tsx` | 下拉选择 |
| `src/components/ui/accordion.tsx` | 折叠面板 |
| `src/components/ConfirmDialog.tsx` | 删除/危险操作确认，支持 destructive/info |
| `src/components/EmptyState.tsx` | 空状态模板 |
| `src/components/LoadingState.tsx` | 骨架/加载占位 |
| `src/components/PageHeader.tsx` | 页面标题 + 描述 + 主操作 |

### 5.4 页面改造清单

| 页面 | 改造点 |
|---|---|
| `DashboardPage` | 统计卡片用 cc-switch card；趋势图嵌入 card；加载/空状态。 |
| `ChannelsPage` | 卡片式列表或 table in card；hover 显示操作；新增/编辑用对话框或全屏面板；接入模型映射。 |
| `ApiKeysPage` | 列表 + key 复制按钮；重命名/配额编辑对话框；启用 switch。 |
| `RoleRoutesPage` | 角色路由表格卡片化；新增角色规则表单对话框；全局兜底卡片。 |
| `SecurityPage` | 设置项用卡片+switch/select；规则列表用 table/card；自定义规则 action 说明。 |
| `LogsPage` | 过滤工具栏用 muted pill；日志表格卡片化；显示完整日期时间；按会话查看日志（已有 trace_id/role，增加会话分组）。 |
| `KnowledgePage` | KB 卡片列表；启用 switch；编辑对话框；文档列表用 card/table；空状态。 |
| `SettingsPage` | 分组卡片；端口保存+重启；CLI 写入卡片；导入导出卡片。 |

### 5.5 日志按会话查看

需求提到“日志关联会话，并按会话查看日志”。当前 `request_logs` 有 `trace_id` 和 `role`。

**实现**
- `LogsPage` 增加“按会话分组”开关或标签页。
- 分组键：`trace_id`（一次请求的所有相关日志）或 `role`（按角色聚合）。
- 后端 `list_logs` 已支持按 `role` / `trace_id` 过滤；前端做两层视图：
  - 平铺列表（现有）。
  - 会话列表：先按 `trace_id` 去重/聚合（最近一条代表会话），点击展开该 trace 的全部日志。

## 6. 数据流与交互

1. 用户打开页面 → 共享 `Layout` 渲染导航与 header。
2. 页面加载数据 via `src/lib/api.ts` → Tauri invoke → 后端 `Repository`。
3. 修改操作成功后显示 `sonner` toast；失败显示 inline error banner 或 toast error。
4. 删除操作先弹出 `ConfirmDialog`。
5. 表单提交前前端校验；后端二次校验。

## 7. 测试计划

- **Rust 单元/集成测试**
  - 新增命令的单元测试：模型映射 CRUD、API key 编辑、KB 状态、自定义规则 action、端口重启。
  - Gemini 流式集成测试：mock Gemini streaming response，验证 SSE accumulator 能正确提取文本与 usage。
  - 运行 `cargo test` 全量通过。
- **前端测试**
  - 更新/新增 Vitest 测试覆盖 `ChannelForm` 校验、`ConfirmDialog`、`EmptyState`、页面主要交互。
  - 运行 `pnpm test:unit` 与 `pnpm typecheck` 通过。
- **端到端验证**
  - `pnpm dev` 启动后，验证：
    - 渠道模型映射生效（请求 model A 被映射到上游 model B）。
    - 角色规则新增/编辑后命中。
    - 端口修改+重启生效。
    - 日志按会话分组可展开。

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| UI 改造范围大，可能破坏现有测试 | 分阶段提交，每阶段跑 `pnpm test:unit` + `cargo test` |
| 端口重启可能导致网关不可用 | 保存旧 handle 并在新服务启动失败时回退/报错 |
| Gemini streaming 协议理解偏差 | 用真实/接近真实的 mock 响应测试 |
| 自定义规则 action 与全局模式冲突 | 取较严 action，并在 UI 明确说明 |

## 9. 交付物

- 后端新命令与修复（Rust）。
- 前端 shadcn/ui 基础组件 + 共享组件。
- 重构后的 8 个页面。
- 更新后的单元/集成测试。
- 更新的 `CLAUDE.md`（如新增命令或项目结构变化显著）。
