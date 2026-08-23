# LLM Gateway 阶段：趋势日期选择(cc-switch 式) + CLI 写盘严格化 设计

> 日期: 2026-08-23
> 前置: 阶段「会话/Skills/Prompt/MCP 管理」已合并（commit 48a37df）。
> 需求来源: `docs/fix.md` 第 5、6 项。

## 1. 目标与非目标

**目标**
1. **趋势日期选择（项 5）**：将日志页与概览页的趋势日期选择统一为 cc-switch「使用趋势」的日期选择方式——预设（当天/1d/7d/14d/30d）+ 日历自定义（日期+时间，支持「结束跟随当前时刻」）。移植 cc-switch 的 `UsageDateRangePicker` + `usageRange.ts` 到本仓库（无新依赖）。
2. **CLI 写盘严格化（项 6）**：Claude Code 的「CLI 一键写入」只修改 `settings.json` 的 `env.ANTHROPIC_BASE_URL` 与 `env.ANTHROPIC_AUTH_TOKEN` 两个变量，保留其余全部键；**不再写 `.claude.json`**（移除 `hasCompletedOnboarding` 注入）。

**非目标**
- 不改 cc-switch 交互的复杂度（照搬完整版：预设 + 日历 + 时间 + live-end），不做精简版。
- 不为日期选择引入第三方依赖（react-day-picker / date-fns 等）。
- 不改代码x `codex` 写盘路径（本次仅 Claude Code 的 settings.json 严格化）。
- 不改现有日志列表/统计/趋势的 API 契约（`after`/`before` 秒级过滤语义不变）。
- 不做会话、MCP、Skills、Prompt 等其它模块的任何改动。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 项 6 范围 | **严格仅写两个变量**：只写 `settings.json` 的 `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN`，移除 `.claude.json` 的 `hasCompletedOnboarding` 写入 |
| 项 5 实现方式 | **移植 cc-switch 完整组件**（`UsageDateRangePicker` + `usageRange.ts`），无新依赖 |
| 项 5 应用位置 | **日志页 + 概览趋势** 两处都替换/新增日期选择 |
| 日志页默认预设 | `7d`（比现「全时间」更聚焦） |
| 概览趋势默认预设 | `today`（当天，保持现有「今日趋势」语义） |

## 3. 模块划分

### 3.1 日期范围工具 `src/lib/usageRange.ts`（新建，移植 cc-switch）

```ts
export type UsageRangePreset = "today" | "1d" | "7d" | "14d" | "30d" | "custom";
export interface UsageRangeSelection {
  preset: UsageRangePreset;
  customStartDate?: number; // unix 秒
  customEndDate?: number;   // unix 秒
  liveEndTime?: boolean;    // custom 时结束时间跟随当前时刻
}
export function resolveUsageRange(selection, nowMs?): { startDate: number; endDate: number }
```

语义（照搬 cc-switch `usageRange.ts`）：
- `today`：本地当日 0 点 → now。
- `1d`：now − 24h → now。
- `7d/14d/30d`：本地日界回看 N−1 天 → now（日历天粒度）。
- `custom`：`customStartDate` → `liveEndTime ? now : (customEndDate ?? now)`；缺省 start 用 now−24h。

### 3.2 日期选择器组件 `src/components/UsageDateRangePicker.tsx`（新建，移植 cc-switch）

- Popover 触发器 Button：CalendarDays 图标 + 当前选择标签（预设名或「日历筛选」）+ 下箭头。
- Popover 内容（约 620px）：
  - 顶部预设按钮行：`当天 / 1d / 7d / 14d / 30d`（点选即应用并关闭）。
  - 左侧字段卡：开始时间/结束时间（`type="date"` + `type="time"` 输入，点击卡片切换 active 字段）+「结束时间跟随当前时刻」checkbox + 校验错误文案（开始晚于结束）+ 取消/确定按钮。
  - 右侧日历：月导航（左右箭头 + 点月份跳今天）、星期表头、42 格日网格（范围高亮：端点实心、区间填充、今天描边）。
- Props：`{ selection: UsageRangeSelection; onApply: (s: UsageRangeSelection) => void; triggerLabel: string }`。
- 文案全部中文（用常量表，本项目无 i18n）。

### 3.3 日志页 `src/pages/LogsPage.tsx`（修改）

- 移除过滤器栏的两个原生 `<input type="date">`（起始日期/结束日期），替换为 `UsageDateRangePicker`。
- 新增 state `rangeSel: UsageRangeSelection`（默认 `{ preset: "7d" }`）。
- 触发器标签：当前预设中文名（当天/1d/7d/14d/30d/日历筛选），显示在过滤器栏。
- `onApply(sel)`：`setRangeSel(sel)` → 解析 `resolveUsageRange(sel)` → `updateFilter({ after: startDate, before: endDate })` → 触发 `onSearch()`（列表+统计+趋势刷新）。
- 死代码清理（精确）:`dateToEndOfDaySeconds` **保留**（`onDeleteBefore` 的 cleanup-date 仍用，LogsPage.tsx:350）；`dateToSeconds` 与 `formatDateInput` 若替换输入框后不再被引用则删除。`bucketSize` 自适应逻辑不变。
- 保留「清理日志」卡片的 `cleanup-date` 原生 date input（那是删除操作，非趋势筛选，不在本次范围）。

### 3.4 概览页 `src/pages/DashboardPage.tsx`（修改）

- 「今日趋势」CardHeader 右侧（维度 tab 旁）加 `UsageDateRangePicker`。
- 新增 state `rangeSel`（默认 `{ preset: "today" }`）+ `bucketSecs`（默认 3600）。
- 默认加载：`resolveUsageRange({ preset: "today" })`（cc-switch 语义 = 本地当日 0 点 → now）→ `getLogTimeseries({ after, before }, 3600)`。注：与现「滚动最近 24h」略异——清晨时段 today 窗口更短，这是 cc-switch「当天」的预期行为。
- `onApply(sel)`：解析范围 → 自适应 bucket（`end−start ≤ 48h → 3600，否则 86400`，与日志页同规则）→ refetch `getLogTimeseries({ after, before }, bucketSecs)`。
- 移除 `TREND_WINDOW_SECS` 常量（由预设驱动）；`TREND_BUCKET_SECS` 由 `bucketSecs` state 取代。

### 3.5 类型 `src/types/index.ts`（修改）

新增 `UsageRangePreset`、`UsageRangeSelection`（与 3.1 一致）。

### 3.6 CLI 写盘严格化 `src-tauri/src/cli_config/claude_code.rs`（修改）

- `write(home, base_url, token)`：**只返回 settings.json 一个结果**——`merge_settings`（已只改两个 env 变量）+ `backup_and_write`；**删除 `.claude.json` 的 `merge_dotclaude` 调用与写入**。
- 删除 `merge_dotclaude` 函数、`dotclaude_path` 辅助、以及对应的测试（`merge_dotclaude_sets_onboarding_keeps_rest`、`write_creates_files_and_backup` 中 `.claude.json` 相关断言）。
- `read_opt` 保留（settings.json 读取仍用）。
- 检查 `dotclaude_path` 是否被 `commands/config.rs::get_cli_targets` 引用——若引用则相应移除该引用。
- ⚠️ 权衡（按用户选择接受）：不再注入 `hasCompletedOnboarding`，若用户从未完成过 Claude Code onboarding，CC 可能忽略 env（需手动过一次登录页）。

## 4. 数据流

1. **日志页**：挂载默认 `{ preset: "7d" }` → `resolveUsageRange` → `after/before` → `loadList` + `loadStatsTrend`。用户选预设/日历 → `onApply` → 同上刷新。
2. **概览**：默认 `{ preset: "today" }` → 24h 窗口 + 3600 bucket → 趋势图。用户选范围 → 自适应 bucket → 刷新。
3. **CLI 写盘**：`write_cli_config("claude_code", key, _)` → `claude_code::write` → 只写 settings.json（两 env 变量合并 + 备份）→ 返回单个 `CliWriteResult`。

## 5. 测试计划

- **Rust**（项 6）：
  - `write` 只写 settings.json、不再创建/修改 `.claude.json`（tempdir 断言 `.claude.json` 不存在或内容不变）。
  - `merge_settings` 既有测试保留（两变量 + 无关键保留）。
  - `cargo test --lib` 全绿（354 现有 + 调整）。
- **前端**（项 5）：
  - `usageRange` 单测：各预设边界（today 日界、7d 回看、custom 无/有 endDate、liveEndTime 取 now）。
  - `LogsPage` 测试：渲染选择器触发器；选 7d 预设 → `listLogs` 参数 after/before 正确（与 now 的容差断言）。
  - `DashboardPage` 测试：选 30d 预设 → `getLogTimeseries` 参数 after 为 ~29 天前、bucket 86400。
  - `pnpm typecheck` + `pnpm test:unit` 全绿（135 现有 + 新增）。
- 手动 `pnpm dev` 验证（可选）：选择器交互、两页联动、写盘后检查 `~/.claude/settings.json` 与 `.claude.json`。

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 移除 `hasCompletedOnboarding` 后 CC 忽略 env（未完成 onboarding 用户） | 用户已明确选择「严格仅写两个变量」；文档中说明一次手动登录即可 |
| 移植组件交互复杂、改动大 | 照搬 cc-switch 已验证组件；仅做中文文案替换与 props 适配 |
| 默认预设改变（日志页 7d）改变用户既有视图 | 属预期改进；选择器可随时切回更大范围/自定义 |
| 概览「今日趋势」语义变化 | 默认 today 保持现有行为；bucket 自适应保证长范围不画成 1px 竖条 |

## 7. 交付物

- 后端：`cli_config/claude_code.rs` 严格化（删 `.claude.json` 写入 + 死代码 + 测试）。
- 前端：`src/lib/usageRange.ts`、`src/components/UsageDateRangePicker.tsx`（新建）；`LogsPage`、`DashboardPage`、`types/index.ts`（修改）。
- 测试：Rust 单测 + 前端单测。
- 更新的 `CLAUDE.md`（新组件/工具）。
