# LLM Gateway 阶段：整流器 + 趋势线图 + CLI JSON 编辑 + 动态模型表单 设计

> 日期: 2026-08-23
> 前置: 阶段「Auto 角色路由」已合并；阶段「功能补全 + UI cc-switch 化改造」已合并（commit 6473b87）。
> 需求来源: `docs/fix.md` 的 4 项要求。

## 1. 目标与非目标

**目标**
1. 渠道支持模型表单改为动态多输入框（可增删），替代当前逗号分隔单输入。
2. 日志趋势（及所有趋势）改用线图，参考 cc-switch「使用统计→使用趋势」的 Recharts 面积图风格。
3. 设置「CLI 一键写入」增加配置 JSON 编辑：读现有配置文件 → 展示为可编辑 JSON → 写回（保留备份），而非当前仅「一键写入替换」。
4. 实现 cc-switch 的「整流器」（Rectifier）路由功能：针对 Anthropic 上游兼容性错误原地修改请求体并同渠道重试，外加发送前图片降级；配置页复刻 5 开关。

**非目标**
- 不改表结构 / 不加迁移（整流器配置存 store.bin，不落 SQLite 新表）。
- 不引入 CodeMirror（CLI JSON 编辑器用 textarea + 实时 JSON 校验 + 格式化按钮）。
- 不改整流器重试的日志语义（一次成功转发只记一行日志，整流重试静默、不计入 failover/熔断）。
- 不做整流器对流式（stream）请求的适配（cc-switch 整流器主要服务非流式；流式整流留后续）。**注：本设计整流器只挂非流式 `try_channel`；流式 `forward_stream` 不接入。**
- 不改变已确认的 Auto 角色路由语义。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 整流器范围 | 完整 5 开关（thinking_signature / thinking_budget / media_fallback / media_heuristic / enabled） |
| 趋势图技术 | 引入 Recharts，照搬 cc-switch AreaChart 风格 |
| CLI 编辑语义 | 读现有配置 → 编辑 JSON → 写回（保留备份） |
| 执行方式 | 一个阶段全部做完（单 spec / 单 plan） |
| risk 维度线图 | stacked area（每风险级一条 Area，保留原 6 色） |
| CLI JSON 编辑器 | textarea + JSON 校验 + 格式化（不引入 CodeMirror） |
| 整流器重试 | 静默同渠道重试一次，不计 failover、不额外记日志 |

## 3. 模块划分（贴合现有分层）

### 3.1 整流器（后端新功能，唯一动转发管线）

**新模块** `src-tauri/src/proxy/rectifier/`（或 `src-tauri/src/rectifier/`，按现有 `security`/`knowledge` 平级习惯放 `proxy/` 下更贴切，因它操作上游请求体）：

| 文件 | 职责 |
|---|---|
| `rectifier/mod.rs` | `RectifierConfig` 结构（`#[derive(Clone, Serialize, Deserialize)]`，5 布尔，默认全 true）+ store.bin 读写（`get_rectifier_config(app)` / `apply_settings(state, cfg)`）+ `merge_from_store` 纯函数（镜像 `security/mod.rs` 模式） |
| `rectifier/thinking_signature.rs` | `should_rectify_thinking_signature(error_msg, cfg) -> bool`（小写子串匹配 7 个场景）+ `rectify_anthropic_request(&mut body)`（遍历 messages[].content，删 `type=="thinking"|"redacted_thinking"` block、移除非 thinking block 的 `signature` 字段、必要时删顶层 `thinking`） |
| `rectifier/thinking_budget.rs` | `should_rectify_thinking_budget(error_msg, cfg) -> bool` + `rectify_thinking_budget(&mut body)`（处理 budget_tokens / thinking 约束，返回 before/after 可选） |
| `rectifier/media.rs` | `apply_media_prevention(body, model, cfg)`（发送前，对纯文本模型注册表把图片 block 替换为 `[Unsupported Image]`；`request_media_heuristic` 前置判断） |

**接入点**：`src-tauri/src/proxy/forwarder.rs` 的 `try_channel`（非流式）：
1. 发送前：若 `upstream_protocol == "anthropic-messages"` 且 `cfg.request_media_fallback`（及 heuristic 判断），`body = apply_media_prevention(body, model, cfg)`。
2. 收到错误（`ForwardError::Upstream { status, body: text }`）：若 `cfg.request_thinking_signature` 且 `should_rectify_thinking_signature(&text, &cfg)` 命中 → `rectify_anthropic_request(&mut body)`；否则若 `cfg.request_thinking_budget` 且 `should_rectify_thinking_budget(&text, &cfg)` 命中 → `rectify_thinking_budget(&mut body)`。任一修改使 body 实际变化 → 用**同一渠道**重发一次。**重试上限：对同一上游错误，signature 与 budget 至多各整流一次、合计最多一次重试**（两者命中其一即重试一次；重试仍失败则返回原始错误，继续走 failover / 返回）。

**AppState**：`src-tauri/src/proxy/state.rs` 增 `rectifier: Arc<RwLock<RectifierConfig>>`（`AppState::new` 默认全 true）。

**持久化**：store.bin 键 `rectifier.enabled` / `rectifier.request_thinking_signature` / `rectifier.request_thinking_budget` / `rectifier.request_media_fallback` / `rectifier.request_media_heuristic`（镜像 security 设置键格式；`lib.rs` setup 启动时读取并 `apply_settings`）。

**命令**（新增 `src-tauri/src/commands/rectifier.rs`，`commands/mod.rs` 注册）：
- `get_rectifier_config(state) -> RectifierConfig`
- `set_rectifier_config(state, app, key: String, value: bool) -> Result<(), String>`（写 state + store.bin 保存）
- 注册进 `invoke_handler!` + `src/lib/api.ts`（`getRectifierConfig` / `setRectifierConfig(key, value)`）。

**UI**：`src/pages/SettingsPage.tsx` 新增「整流器」Card（或并入现有设置分组）：5 个 `Switch`（总开关 + 4 子开关），乐观保存（点击即更新 state，失败 toast.error 回滚）；子开关在总开关关闭时 disabled；`request_media_heuristic` 受 `request_media_fallback` 级联禁用；每行 `Label` + `text-xs text-muted-foreground` 描述。

**测试**：
- 纯函数单测：`should_rectify_thinking_signature` 命中/未命中各场景；`rectify_anthropic_request` 删除 thinking block / 去 signature / 保留正常内容；`should_rectify_thinking_budget` + budget 修改；`apply_media_prevention` 图片替换 + 文本保留。
- 集成测试（`src-tauri/tests/rectifier.rs`）：mock Anthropic 上游第一次返回 signature 错误、第二次返回 200 → 断言最终成功且第二次请求 body 无 thinking block / 无 signature；mock 返回图片 → 断言 body 含 `[Unsupported Image]`。
- 若 e2e 受本机系统代理影响（503），以 `NO_PROXY=127.0.0.1,localhost` 运行或以 `cargo test --lib` 单测为准并注明。

### 3.2 趋势线图（前端）

**依赖**：`pnpm add recharts`。

**重写** `src/components/LogTrendChart.tsx`：
- 改用 Recharts `<AreaChart>`，保留对外 API `{ buckets, dimension, bucketSecs }` 与 `Dimension` 类型（Dashboard 与 Logs 复用不变）。
- 数据映射：`TimeBucket { bucket, calls, input_tokens, output_tokens, error_count, risk_counts }` → chartData：
  - calls：单条 Area（`#3b82f6`）
  - tokens：input（`#3b82f6`）+ output（`#22c55e`）双 Area
  - success：成功率单条 Area（`#22c55e`），`(calls - error_count) / calls * 100`
  - risk：stacked area，每条 risk level（clean/info/low/medium/high/critical，保留原 6 色）一个 Area stackId="risk"
- 风格照搬 cc-switch：`CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))"`、`XAxis` label 用 `formatBucketLabel`、Y 轴 `tickFormatter`（k 单位）、自定义 Tooltip（`rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-md`）、渐变 `defs`、`Area type="monotone" strokeWidth={2}`。
- 保留 `niceCeil` / `formatBucketLabel` / `computeTicks` 等导出（测试依赖），或内联适配。
- 空数据 / 加载状态沿用（`EmptyState` / `LoadingState`）。

**测试**：更新 `src/components/__tests__/LogTrendChart.test.tsx`（原断言 fillRect/bar 的用例改为断言 Recharts 渲染的元素 / 各 dimension 的 series；若 Recharts 在 jsdom 渲染受限，则断言传入的数据映射函数输出 / 组件 props，或 mock Recharts）。Dashboard / Logs 页测试若引用 chart 内部结构则同步更新。

### 3.3 CLI 配置 JSON 编辑（后端 + 前端）

**后端**（新增 `src-tauri/src/commands/cli.rs`，`commands/mod.rs` 注册）：
- `read_cli_config(target: String) -> Result<String, String>`：按 target 读现有配置文件，返回**JSON 文本**（Claude Code：读 `~/.claude/settings.json` 原样返回；Codex：读 `~/.codex/config.toml` 经 `toml::Value` → `serde_json::to_string_pretty` 转 JSON 返回）。文件不存在返回空配置 JSON（`{}`）。
- `write_cli_config_content(target: String, json_content: String) -> Result<CliWriteResult, String>`：校验 `json_content` 为合法 JSON 对象；Claude Code 直接写回 `settings.json`（+ `.claude.json` 的 onboarding 处理保留现有 `merge_dotclaude`）；Codex 将 JSON 转回 `toml::Value` 写回 `config.toml`。均走现有 `backup_and_write`（保留 `.bak`）。
- 保留现有 `write_cli_config`（一键写入）不动。
- 注册 + api.ts：`readCliConfig(target)` / `writeCliConfigContent(target, jsonContent)`。

**前端** `src/pages/SettingsPage.tsx`：
- CLI 卡保留：目标 Select + API 密钥 Select + 一键写入按钮（现有）。
- 新增「编辑配置」：按钮 → 展开 `textarea`（或 Dialog），读 `readCliConfig(target)` 填充；`textarea` 上方显示当前目标；**实时 JSON 校验**（`JSON.parse`，失败红字提示行）；「格式化」按钮（`JSON.stringify(parsed, null, 2)`）；「保存」→ `writeCliConfigContent(target, content)` → toast 成功 / 失败；保存成功后刷新 CLI targets 状态。
- Codex 目标在 textarea 上方标注「config.toml（将转为 JSON 编辑）」。

### 3.4 动态模型多输入框（前端）

**修改** `src/components/ChannelForm.tsx`：
- `models: string[]` 保持；表单内改为动态列表：每个模型一个 `Input` + 删除按钮（`Trash2`），底部「添加模型」按钮（`Plus`）。
- 防失焦：用 `crypto.randomUUID()` 稳定 key 数组（`useRef<string[]>`），增删时同步 push/splice key；渲染 `models.map((m, i) => <div key={keys[i]}>...`。
- 保留 Task 4 校验：`validateForm` 的 `models` 规则（至少一个非空 trim）不变；错误提示位置适配多行（在列表下方统一显示）。
- 现有测试 `ChannelForm.test.tsx` 若按「逗号分隔输入」交互编写则改为「逐个添加」交互；保留校验断言。
- `ChannelsPage` 无需改（ChannelForm 对外接口不变）。

## 4. 数据流与交互

1. 整流器：请求 → `try_channel` 构造 body（媒体降级）→ 上游错误 → 判定整流 → 改 body → 同渠道重试 → 成功则正常返回（日志一行）；失败则返回错误走 failover。
2. 趋势：Dashboard / Logs 传 `TimeBucket[]` → `LogTrendChart` 映射 chartData → Recharts 渲染。
3. CLI 编辑：SettingsPage 读现有配置 JSON → textarea 编辑 → JSON 校验 → 写回（备份）。
4. 模型表单：ChannelForm 内 `models` 数组 ↔ 动态输入列表双向同步，提交时仍以 `models: string[]` 传给现有 `createChannel` / `updateChannel`。

## 5. 测试计划

- **Rust**：整流器纯函数单测 + `tests/rectifier.rs` 集成测试；`cargo test --lib` 全绿（280+ 现有 + 新增）。
- **前端**：`LogTrendChart.test.tsx` 更新 + `ChannelForm.test.tsx` 更新 + SettingsPage CLI 编辑测试；`pnpm typecheck` + `pnpm test:unit` 全绿。
- 若 e2e 受本机代理影响（503），用 `NO_PROXY=127.0.0.1,localhost` 运行；非本机可正常。

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 整流器改请求体后上游仍报错 → 无限重试 | 每渠道最多重试 1 次（signature + budget 各自一次，共用同一上限），失败返回原错误 |
| Recharts 引入体积/兼容 | 仅 LogTrendChart 使用；jsdom 渲染受限时用数据映射单测兜底 |
| Codex TOML↔JSON 往返丢失注释/格式 | 接受（cc-switch 亦然）；写回前 JSON 校验 + 保留 `.bak` |
| CLI 编辑写坏现有配置 | `backup_and_write` 保留 `.bak`；JSON 校验拦截非法内容 |
| 动态模型输入框失焦 | `crypto.randomUUID()` 稳定 key 防重挂载（照搬 cc-switch OpenClaw 模式） |

## 7. 交付物

- 后端：`proxy/rectifier/*` 模块 + `AppState.rectifier` + 整流器接入 `try_channel` + `get/set_rectifier_config` 命令 + `read_cli_config` / `write_cli_config_content` 命令。
- 前端：`LogTrendChart` Recharts 重写 + SettingsPage 整流器 Card + CLI JSON 编辑 + ChannelForm 动态模型表单。
- 测试：Rust 单测/集成 + 前端测试更新。
- 更新的 `CLAUDE.md`（如新增命令/模块结构变化显著）。
