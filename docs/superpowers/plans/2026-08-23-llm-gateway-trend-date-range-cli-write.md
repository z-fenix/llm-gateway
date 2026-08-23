# 趋势日期选择(cc-switch 式) + CLI 写盘严格化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把日志页/概览页的趋势日期选择统一为 cc-switch「使用趋势」式（预设 + 日历自定义 + live-end），并让 Claude Code 的 CLI 写盘严格只改 `settings.json` 两个 env 变量、不再触碰 `.claude.json`。

**Architecture:** 前端新增纯逻辑 `src/lib/usageRange.ts`（无依赖，可单测）+ 移植自 cc-switch 的 `src/components/UsageDateRangePicker.tsx`（新增两个同族 Radix 原语 `@radix-ui/react-popover` / `@radix-ui/react-checkbox` 与标准 shadcn 包装），替换日志页两个原生日期输入、给概览「今日趋势」加选择器。后端删掉 `claude_code::merge_dotclaude`/`dotclaude_path` 与两条写盘路径中的 `.claude.json` 写入。

**Tech Stack:** React 18 + TS + Tailwind v3.4（container queries）+ lucide-react；Radix UI 原语（popover/checkbox，与项目既有 accordion/dialog/label/select/switch 同族）；Rust（rusqlite/tauri command 不改契约）。

**Spec:** docs/superpowers/specs/2026-08-23-llm-gateway-trend-date-range-cli-write-design.md

## Global Constraints

（以下为 spec 的硬性要求，逐条从 spec 复制；每个任务隐含遵守本段。）

- **项 6（CLI 写盘严格化）**：Claude Code 配置写入严格仅改 `settings.json` 的 `env.ANTHROPIC_BASE_URL` 与 `env.ANTHROPIC_AUTH_TOKEN` 两个变量，保留其余全部键；**不写 `.claude.json`**（移除 `hasCompletedOnboarding` 注入）。两条写盘路径都改：`cli_config/claude_code.rs::write` 与 `commands/cli.rs::write_cli_config_content_with_home`。
- **项 5（日期选择）**：移植 cc-switch 完整版——预设（当天/1d/7d/14d/30d）+ 日历自定义（日期+时间、live-end「结束时间跟随当前时刻」）；日志页默认 `7d`、概览趋势默认 `today`。
- **无新第三方日期库**（react-day-picker / date-fns 等）。**RULING**：为忠实移植 cc-switch 组件，新增两个与项目现有 Radix 原语同族的 headless UI 依赖 `@radix-ui/react-popover` + `@radix-ui/react-checkbox`（项目已有 5 个 `@radix-ui/*` 依赖，shadcn 风格）；「无新依赖」按日期库理解，不含同族 UI 原语。
- `resolveUsageRange` 语义（照搬 cc-switch）：`today` = 本地当日 0 点→now；`1d` = now−24h→now；`7d/14d/30d` = 本地日界回看 N−1 天→now；`custom` = `customStartDate`→(`liveEndTime ? now : (customEndDate ?? now)`)，缺省 start = now−24h。
- 趋势 bucket 自适应：`end−start ≤ 48h → 3600，否则 86400`（日志页与概览页同规则）。
- UI 文案全中文（本项目无 i18n，用 `L10N` 常量表）。
- 删除死代码需精确：LogsPage 的 `dateToEndOfDaySeconds` **保留**（`onDeleteBefore` 清理用），`dateToSeconds`/`formatDateInput` 在替换输入框后删除。
- 后端命令从 `src-tauri/` 运行；前端命令从仓库根运行。全量 Rust 测试需 `NO_PROXY=127.0.0.1,localhost`（本机系统代理会导致 e2e 503/flaky）。

## File Structure

| 文件 | 任务 | 职责 |
|---|---|---|
| `src-tauri/src/cli_config/claude_code.rs` | T1 | 删 `.claude.json` 写入 + 死代码 |
| `src-tauri/src/commands/cli.rs` | T1 | JSON 编辑器写回路径同步删 `.claude.json` 写入 |
| `src/types/index.ts` | T2 | 新增 `UsageRangePreset`/`UsageRangeSelection` |
| `src/lib/usageRange.ts`（新建） | T2 | 纯逻辑：预设解析 + 中文标签 |
| `src/lib/__tests__/usageRange.test.ts`（新建） | T2 | usageRange 单测 |
| `package.json` / `pnpm-lock.yaml` | T3 | 新增 radix popover/checkbox 依赖 |
| `src/components/ui/popover.tsx`（新建） | T3 | shadcn Popover 包装 |
| `src/components/ui/checkbox.tsx`（新建） | T3 | shadcn Checkbox 包装 |
| `src/index.css` | T3 | `.usage-range-*` container-query 布局（照搬 cc-switch） |
| `src/components/UsageDateRangePicker.tsx`（新建） | T4 | 移植组件（中文文案） |
| `src/components/__tests__/UsageDateRangePicker.test.tsx`（新建） | T4 | 组件测试 |
| `src/pages/LogsPage.tsx` | T5 | 用选择器替换两个日期输入，默认 7d |
| `src/pages/__tests__/LogsPage.test.tsx` | T5 | 更新：删除日期输入交互，改用选择器 |
| `src/pages/DashboardPage.tsx` | T6 | 趋势卡加选择器，默认 today，自适应 bucket |
| `src/pages/__tests__/DashboardPage.test.tsx` | T6 | 更新 today 断言 + 新增 30d 断言 |
| `CLAUDE.md` | T7 | 记录新组件/工具与写盘行为 |

---

### Task 1: Claude Code 写盘严格化（后端，项 6）

**Files:**
- Modify: `src-tauri/src/cli_config/claude_code.rs`
- Modify: `src-tauri/src/commands/cli.rs`
- Test: 同文件内 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::cli_config::{backup_and_write, CliWriteResult}`（已在 mod.rs 定义）
- Produces: `claude_code::write(home: &Path, base_url: &str, token: &str) -> Result<Vec<CliWriteResult>, String>` 现在**只返回 1 个元素**（settings.json）；`dotclaude_path` / `merge_dotclaude` 被删除，任何调用它们的代码必须一并修改。
- 前端 `SettingsPage` 渲染 `CliWriteResult[]`（map 遍历），单个元素数组兼容，无需前端改动。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/cli_config/claude_code.rs` 的 `mod tests` 中**新增**两个测试（保留旧测试先不动）：

```rust
#[test]
fn write_only_writes_settings_returns_single_result_and_preserves_dotclaude() {
    let home = tempfile::tempdir().unwrap();
    // 预置 .claude.json,确保 write 不修改它
    let dp = home.path().join(".claude.json");
    std::fs::write(&dp, r#"{"userID":"u1"}"#).unwrap();

    // 先写一次(无备份),再写一次(有备份)
    let r1 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-a").unwrap();
    assert!(settings_path(home.path()).exists());
    assert_eq!(r1.len(), 1, "只写 settings.json,只返回一个结果");
    assert!(r1[0].backup_path.is_none());

    let r2 = write(home.path(), "http://127.0.0.1:8779", "sk-lgw-b").unwrap();
    assert_eq!(r2.len(), 1);
    assert!(r2[0].backup_path.is_some());

    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
    assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], serde_json::json!("sk-lgw-b"));

    // .claude.json 保持原样(不新增 onboarding 注入)
    assert_eq!(std::fs::read_to_string(&dp).unwrap(), r#"{"userID":"u1"}"#);
}

#[test]
fn write_never_creates_dotclaude_when_absent() {
    let home = tempfile::tempdir().unwrap();
    write(home.path(), "http://127.0.0.1:8779", "sk-lgw-a").unwrap();
    assert!(!home.path().join(".claude.json").exists());
}
```

- [ ] **Step 2: 运行验证失败**

Run（在 `src-tauri/`）: `cargo test --lib cli_config::claude_code::tests::write_only_writes_settings_returns_single_result_and_preserves_dotclaude -- --nocapture` 以及 `...::write_never_creates_dotclaude_when_absent`
Expected: FAIL——当前 `write` 返回 2 个结果、会创建并改写 `.claude.json`（`assert_eq!(r1.len(), 1)` 得 2；`.claude.json` 被改、被创建）。

- [ ] **Step 3: 实现严格化**

改写 `src-tauri/src/cli_config/claude_code.rs`：

1. 删除 `dotclaude_path` 函数（当前第 7-9 行）：
```rust
// 删除:
pub fn dotclaude_path(home: &Path) -> PathBuf {
    home.join(".claude.json")
}
```
（`PathBuf` 仍被 `settings_path` 用到，`use std::path::{Path, PathBuf}` 保留。）

2. 删除 `merge_dotclaude` 函数（当前第 57-73 行整段）。

3. 把 `write` 改为只写 settings.json：

```rust
/// 写 settings.json(仅 env.ANTHROPIC_BASE_URL + env.ANTHROPIC_AUTH_TOKEN 两个变量,
/// 保留其余全部键),不触碰 .claude.json。返回单个 CliWriteResult。
pub fn write(home: &Path, base_url: &str, token: &str) -> Result<Vec<CliWriteResult>, String> {
    let sp = settings_path(home);
    let (content, changed) = merge_settings(read_opt(&sp)?.as_deref(), base_url, token)?;
    let backup = backup_and_write(&sp, &content)?;
    Ok(vec![CliWriteResult {
        path: sp.display().to_string(),
        changed_keys: changed,
        backup_path: backup,
        env_instructions: None,
    }])
}
```

4. 删除已被取代的旧测试 `write_creates_files_and_backup`（当前第 182-202 行）与 `merge_dotclaude_sets_onboarding_keeps_rest`（当前第 143-150 行）。保留 `merge_settings_*`、`read_opt_*`、`backup_and_write_ts_*` 测试。

5. 同步修改 `src-tauri/src/commands/cli.rs`（否则 `dotclaude_path`/`merge_dotclaude` 删除后编译失败）——`write_cli_config_content_with_home` 的 `"claude_code"` 分支，删除 `.claude.json` 处理（当前第 69-72 行与第 79 行注释）：

```rust
"claude_code" => {
    let sp = claude_code::settings_path(home);
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let backup = backup_and_write(&sp, &pretty)?;
    // 严格只写 settings.json;不再注入 .claude.json hasCompletedOnboarding
    Ok(CliWriteResult {
        path: sp.display().to_string(),
        changed_keys: vec!["env".to_string()],
        backup_path: backup,
        env_instructions: None,
    })
}
```

6. 修改 `commands/cli.rs` 测试 `write_cli_config_content_creates_backup`（当前第 244-269 行）——删除 `.claude.json` 相关断言（当前第 264-268 行）：

```rust
#[test]
fn write_cli_config_content_creates_backup() {
    let home = tempfile::tempdir().unwrap();
    let p = claude_code::settings_path(home.path());
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, r#"{"model":"opus"}"#).unwrap();

    let r = write_cli_config_content_with_home(
        home.path(),
        "claude_code",
        r#"{"model":"sonnet","env":{"A":"1"}}"#,
    )
    .unwrap();
    assert!(r.backup_path.is_some());
    assert!(p.with_file_name("settings.json.bak").exists());

    // 主文件内容为新 JSON
    let written = std::fs::read_to_string(&p).unwrap();
    let v: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(v["model"], serde_json::json!("sonnet"));
    // .claude.json 不再被创建或修改
    assert!(!home.path().join(".claude.json").exists());
}
```

- [ ] **Step 4: 运行测试验证通过**

Run（在 `src-tauri/`）: `cargo test --lib`
Expected: PASS（`cli_config::claude_code` 与 `commands::cli` 全部通过，含两个新测试）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli_config/claude_code.rs src-tauri/src/commands/cli.rs
git commit -m "refactor(cli): Claude Code 写盘严格化,仅改 settings.json 两个 env 变量,移除 .claude.json onboarding 注入"
```

---

### Task 2: 日期范围类型与解析库（前端逻辑层，项 5）

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/lib/usageRange.ts`
- Test: `src/lib/__tests__/usageRange.test.ts`

**Interfaces:**
- Consumes: 无（纯 TS，无外部依赖）
- Produces:
  - `export type UsageRangePreset = "today" | "1d" | "7d" | "14d" | "30d" | "custom"`（类型定义在 `src/types/index.ts`）
  - `export interface UsageRangeSelection { preset: UsageRangePreset; customStartDate?: number; customEndDate?: number; liveEndTime?: boolean }`（`src/types/index.ts`）
  - `export function resolveUsageRange(selection: UsageRangeSelection, nowMs?: number): { startDate: number; endDate: number }`（`src/lib/usageRange.ts`，默认 `nowMs = Date.now()`）
  - `export function getUsageRangePresetLabel(preset: UsageRangePreset): string`（中文标签：当天/1d/7d/14d/30d/日历筛选）
- T3/T4/T5/T6 依赖本任务的类型与函数签名。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/usageRange.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveUsageRange, getUsageRangePresetLabel } from "../usageRange";

const FIXED_NOW = new Date(2024, 0, 15, 12, 30, 0).getTime(); // 2024-01-15 12:30 本地
const NOW_SEC = Math.floor(FIXED_NOW / 1000);

describe("resolveUsageRange", () => {
  it("today: 本地当日 0 点 → now", () => {
    const r = resolveUsageRange({ preset: "today" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2024, 0, 15, 0, 0, 0).getTime() / 1000);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("1d: now − 24h → now", () => {
    const r = resolveUsageRange({ preset: "1d" }, FIXED_NOW);
    expect(r.startDate).toBe(NOW_SEC - 24 * 3600);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("7d: 本地日界回看 6 天 → now", () => {
    const r = resolveUsageRange({ preset: "7d" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2024, 0, 9, 0, 0, 0).getTime() / 1000);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("30d: 本地日界回看 29 天", () => {
    const r = resolveUsageRange({ preset: "30d" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2023, 11, 17, 0, 0, 0).getTime() / 1000);
  });

  it("custom 缺省 start 用 now−24h,无 endDate 用 now", () => {
    const r = resolveUsageRange({ preset: "custom" }, FIXED_NOW);
    expect(r.startDate).toBe(NOW_SEC - 24 * 3600);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("custom 指定 start/end 且 liveEndTime=false 用固定 end", () => {
    const start = new Date(2024, 0, 10, 0, 0).getTime() / 1000;
    const end = new Date(2024, 0, 12, 23, 59).getTime() / 1000;
    const r = resolveUsageRange(
      { preset: "custom", customStartDate: start, customEndDate: end, liveEndTime: false },
      FIXED_NOW
    );
    expect(r.startDate).toBe(start);
    expect(r.endDate).toBe(end);
  });

  it("custom liveEndTime=true 时 end 取 now", () => {
    const start = new Date(2024, 0, 10, 0, 0).getTime() / 1000;
    const r = resolveUsageRange(
      { preset: "custom", customStartDate: start, liveEndTime: true },
      FIXED_NOW
    );
    expect(r.endDate).toBe(NOW_SEC);
  });
});

describe("getUsageRangePresetLabel", () => {
  it("返回中文预设名", () => {
    expect(getUsageRangePresetLabel("today")).toBe("当天");
    expect(getUsageRangePresetLabel("1d")).toBe("1d");
    expect(getUsageRangePresetLabel("30d")).toBe("30d");
    expect(getUsageRangePresetLabel("custom")).toBe("日历筛选");
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run（仓库根）: `pnpm test:unit`
Expected: FAIL——`../usageRange` 模块不存在（`Cannot find module`）。

- [ ] **Step 3: 类型与实现**

在 `src/types/index.ts` 末尾追加：

```ts
export type UsageRangePreset = "today" | "1d" | "7d" | "14d" | "30d" | "custom";

export interface UsageRangeSelection {
  preset: UsageRangePreset;
  customStartDate?: number;
  customEndDate?: number;
  liveEndTime?: boolean;
}
```

创建 `src/lib/usageRange.ts`（照搬 cc-switch `usageRange.ts`，去掉 i18n `t` 参数）：

```ts
import type { UsageRangePreset, UsageRangeSelection } from "../types";

const DAY_SECONDS = 24 * 60 * 60;
const DAY_MS = DAY_SECONDS * 1000;

export interface ResolvedUsageRange {
  startDate: number;
  endDate: number;
}

function getStartOfLocalDayDate(nowMs: number): Date {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getPresetLookbackStart(
  preset: Exclude<UsageRangePreset, "today" | "1d" | "custom">,
  nowMs: number,
): number {
  const dayCount = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
  return Math.floor(
    getStartOfLocalDayDate(nowMs - (dayCount - 1) * DAY_MS).getTime() / 1000,
  );
}

export function resolveUsageRange(
  selection: UsageRangeSelection,
  nowMs: number = Date.now(),
): ResolvedUsageRange {
  const endDate = Math.floor(nowMs / 1000);

  switch (selection.preset) {
    case "today":
      return {
        startDate: Math.floor(getStartOfLocalDayDate(nowMs).getTime() / 1000),
        endDate,
      };
    case "1d":
      return { startDate: endDate - DAY_SECONDS, endDate };
    case "7d":
    case "14d":
    case "30d":
      return { startDate: getPresetLookbackStart(selection.preset, nowMs), endDate };
    case "custom": {
      const startDate = selection.customStartDate ?? endDate - DAY_SECONDS;
      const customEndDate = selection.liveEndTime
        ? endDate
        : (selection.customEndDate ?? endDate);
      return { startDate, endDate: customEndDate };
    }
  }
}

export function getUsageRangePresetLabel(preset: UsageRangePreset): string {
  switch (preset) {
    case "today":
      return "当天";
    case "1d":
      return "1d";
    case "7d":
      return "7d";
    case "14d":
      return "14d";
    case "30d":
      return "30d";
    case "custom":
      return "日历筛选";
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run（仓库根）: `pnpm test:unit`
Expected: PASS（新增 8 个测试）+ `pnpm typecheck` PASS。

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/usageRange.ts src/lib/__tests__/usageRange.test.ts
git commit -m "feat(usage): 移植 cc-switch 日期范围解析与类型(预设/日历/live-end)"
```

---

### Task 3: Radix popover/checkbox 原语 + container 布局 CSS（UI 基建）

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `src/components/ui/popover.tsx`, `src/components/ui/checkbox.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: 无（仅新增依赖 + 标准 shadcn 包装）
- Produces:
  - `export { Popover, PopoverTrigger, PopoverContent }` from `src/components/ui/popover.tsx`（shadcn 标准 API：`Popover` 受控 `open`/`onOpenChange`；`PopoverTrigger asChild`；`PopoverContent` 接受 `className`/`align`/`sideOffset`）
  - `export { Checkbox }` from `src/components/ui/checkbox.tsx`（`checked`/`onCheckedChange`，值为 `boolean | "indeterminate"`）
- T4 依赖本任务的两个组件与 `src/index.css` 中 `.usage-range-*` 类。

- [ ] **Step 1: 安装依赖**

Run（仓库根）: `pnpm add @radix-ui/react-popover @radix-ui/react-checkbox`
Expected: `package.json` dependencies 新增两行（`^1.x`），`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 创建 popover.tsx**

创建 `src/components/ui/popover.tsx`（标准 shadcn 包装，import 路径用相对 `../../lib/utils`，与 `select.tsx` 一致）：

```tsx
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
```

- [ ] **Step 3: 创建 checkbox.tsx**

创建 `src/components/ui/checkbox.tsx`（标准 shadcn 包装）：

```tsx
import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

import { cn } from "../../lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
```

- [ ] **Step 4: 追加 container-query 布局 CSS**

在 `src/index.css` 末尾追加（照搬 cc-switch `index.css` 的 `.usage-range-*` 规则；Tailwind v3.4 + PostCSS 原生支持 container queries）：

```css
.usage-range-popover {
  container-type: inline-size;
}

@container (min-width: 500px) {
  .usage-range-layout {
    flex-direction: row;
  }
  .usage-range-fields {
    width: 250px;
    flex: none;
  }
  .usage-range-calendar {
    min-width: 0;
    flex: 1 1 0%;
  }
}
```

- [ ] **Step 5: 验证**

Run（仓库根）: `pnpm typecheck`
Expected: PASS。无行为测试（纯基建）；Task 4 的组件测试会覆盖 popover 打开路径。注：jsdom 下打开 radix Popover 与打开既有 radix Select 走同一 popper 栈（`McpServersPage.test.tsx:154` 等已在测），无需在 `setup.ts` 加 mock。

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/ui/popover.tsx src/components/ui/checkbox.tsx src/index.css
git commit -m "feat(ui): 新增 radix popover/checkbox 原语与日期选择器 container 布局 CSS"
```

---

### Task 4: UsageDateRangePicker 组件（移植 cc-switch，项 5）

**Files:**
- Create: `src/components/UsageDateRangePicker.tsx`
- Test: `src/components/__tests__/UsageDateRangePicker.test.tsx`

**Interfaces:**
- Consumes: `src/types` 的 `UsageRangePreset`/`UsageRangeSelection`；`src/lib/usageRange` 的 `resolveUsageRange`/`getUsageRangePresetLabel`；`src/components/ui/{button,input,popover,checkbox}`；`src/lib/utils` 的 `cn`；lucide-react 的 `CalendarDays/ChevronDown/ChevronLeft/ChevronRight`。
- Produces: `export function UsageDateRangePicker({ selection, onApply, triggerLabel }: { selection: UsageRangeSelection; onApply: (s: UsageRangeSelection) => void; triggerLabel: string }): JSX.Element`（**具名导出**）。
- T5/T6 依赖本组件签名。

- [ ] **Step 1: 写失败测试**

创建 `src/components/__tests__/UsageDateRangePicker.test.tsx`：

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { UsageDateRangePicker } from "../UsageDateRangePicker";

describe("UsageDateRangePicker", () => {
  it("触发器显示当前预设标签", () => {
    render(
      <UsageDateRangePicker selection={{ preset: "7d" }} onApply={() => {}} triggerLabel="7d" />
    );
    expect(screen.getByRole("button", { name: /7d/ })).toBeInTheDocument();
  });

  it("点击预设按钮立即应用所选预设", async () => {
    const onApply = vi.fn();
    render(
      <UsageDateRangePicker selection={{ preset: "7d" }} onApply={onApply} triggerLabel="7d" />
    );
    fireEvent.click(screen.getByRole("button", { name: /7d/ }));
    fireEvent.click(await screen.findByRole("button", { name: "1d" }));
    expect(onApply).toHaveBeenCalledWith({ preset: "1d" });
  });

  it("开始时间晚于结束时间时,确定被拒绝并显示错误", async () => {
    const onApply = vi.fn();
    render(
      <UsageDateRangePicker
        selection={{ preset: "custom", customStartDate: 1700003600, customEndDate: 1700000000 }}
        onApply={onApply}
        triggerLabel="日历筛选"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /日历筛选/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确定" }));
    expect(await screen.findByText("开始时间不能晚于结束时间")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("custom 模式显示 live-end 复选框", async () => {
    render(
      <UsageDateRangePicker
        selection={{ preset: "custom", customStartDate: 1700000000, customEndDate: 1700003600 }}
        onApply={() => {}}
        triggerLabel="日历筛选"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /日历筛选/ }));
    expect(await screen.findByText("结束时间跟随当前时刻")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run（仓库根）: `pnpm test:unit UsageDateRangePicker`
Expected: FAIL——模块 `../UsageDateRangePicker` 不存在。

- [ ] **Step 3: 移植组件**

创建 `src/components/UsageDateRangePicker.tsx`（完整移植 cc-switch `UsageDateRangePicker.tsx`；改动点：去 i18n 用 `L10N` 常量、星期表头硬编码中文、月份显示 `YYYY年M月`、`day.toLocaleDateString("zh-CN")`、import 用相对路径、`resolveUsageRange`/`getUsageRangePresetLabel` 用本仓库版本）：

```tsx
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import type { UsageRangePreset, UsageRangeSelection } from "../types";

type DraftField = "start" | "end";

const PRESETS: UsageRangePreset[] = ["today", "1d", "7d", "14d", "30d"];

const L10N = {
  customRangeHint: "支持日期与时间，最长 30 天",
  startTime: "开始时间",
  endTime: "结束时间",
  liveEndTime: "结束时间跟随当前时刻",
  invalidTimeRangeOrder: "开始时间不能晚于结束时间",
  cancel: "取消",
  confirm: "确定",
};

interface UsageDateRangePickerProps {
  selection: UsageRangeSelection;
  onApply: (selection: UsageRangeSelection) => void;
  triggerLabel: string;
}

/* ── helpers ── */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toTs(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function fromTs(ts: number): Date {
  return new Date(ts * 1000);
}

function fmtDate(ts: number): string {
  const d = fromTs(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(ts: number): string {
  const d = fromTs(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function parseDateInput(ts: number, value: string): number {
  const [y, m, d] = value.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ts;
  const base = fromTs(ts);
  return toTs(new Date(y, m - 1, d, base.getHours(), base.getMinutes()));
}

function parseTimeInput(ts: number, value: string): number {
  const [h, min] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return ts;
  const base = fromTs(ts);
  return toTs(
    new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min),
  );
}

function setDateKeepTime(ts: number, day: Date): number {
  const base = fromTs(ts);
  return toTs(
    new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      base.getHours(),
      base.getMinutes(),
    ),
  );
}

function getCalendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

/* ── component ── */

export function UsageDateRangePicker({
  selection,
  onApply,
  triggerLabel,
}: UsageDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<DraftField>("start");
  const resolvedRange = useMemo(() => resolveUsageRange(selection), [selection]);
  const [draftStart, setDraftStart] = useState(resolvedRange.startDate);
  const [draftEnd, setDraftEnd] = useState(resolvedRange.endDate);
  const [draftLiveEnd, setDraftLiveEnd] = useState(
    selection.preset === "custom" ? (selection.liveEndTime ?? false) : false,
  );
  const [displayMonth, setDisplayMonth] = useState(
    () =>
      new Date(
        fromTs(resolvedRange.startDate).getFullYear(),
        fromTs(resolvedRange.startDate).getMonth(),
        1,
      ),
  );
  const [error, setError] = useState<string | null>(null);

  // 打开时把草稿重置为当前选择的解析结果
  useEffect(() => {
    if (!open) return;
    const r = resolveUsageRange(selection);
    setDraftStart(r.startDate);
    setDraftEnd(r.endDate);
    setDraftLiveEnd(
      selection.preset === "custom" ? (selection.liveEndTime ?? false) : false,
    );
    setDisplayMonth(
      new Date(
        fromTs(r.startDate).getFullYear(),
        fromTs(r.startDate).getMonth(),
        1,
      ),
    );
    setActiveField("start");
    setError(null);
  }, [open, selection]);

  // live-end 模式下每秒刷新结束时间
  useEffect(() => {
    if (!open || !draftLiveEnd) return;
    const tick = () => setDraftEnd(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, draftLiveEnd]);

  const calendarDays = useMemo(() => getCalendarDays(displayMonth), [displayMonth]);

  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  const startDay = fromTs(draftStart);
  const endDay = fromTs(draftEnd);
  const today = new Date();

  const handleDatePick = (day: Date) => {
    setError(null);

    // live-end 激活时日历只控制开始日期
    if (draftLiveEnd) {
      const nextTs = setDateKeepTime(draftStart, day);
      setDraftStart(nextTs);
      return;
    }

    const nextTs = setDateKeepTime(
      activeField === "start" ? draftStart : draftEnd,
      day,
    );

    if (activeField === "start") {
      setDraftStart(nextTs);
      // 自动交换:start > end 时把 end 同步为 start
      if (nextTs > draftEnd) {
        setDraftEnd(nextTs);
      }
      // 自动前进到结束字段
      setActiveField("end");
    } else {
      // 选中的结束早于开始时,当作新开始并继续
      if (nextTs < draftStart) {
        setDraftStart(nextTs);
        setActiveField("end");
      } else {
        setDraftEnd(nextTs);
      }
    }

    // 越月则切换日历显示月份
    if (
      day.getMonth() !== displayMonth.getMonth() ||
      day.getFullYear() !== displayMonth.getFullYear()
    ) {
      setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    }
  };

  const handleApply = () => {
    setError(null);
    if (draftStart > draftEnd) {
      setError(L10N.invalidTimeRangeOrder);
      return;
    }
    onApply({
      preset: "custom",
      customStartDate: draftStart,
      customEndDate: draftEnd,
      liveEndTime: draftLiveEnd,
    });
    setOpen(false);
  };

  const goToToday = () => {
    setDisplayMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  const renderField = (field: DraftField) => {
    const isActive = activeField === field;
    const isEndLive = field === "end" && draftLiveEnd;
    const ts = field === "start" ? draftStart : draftEnd;
    const setTs = field === "start" ? setDraftStart : setDraftEnd;
    const label = field === "start" ? L10N.startTime : L10N.endTime;

    return (
      <div
        className={cn(
          "rounded-lg border px-3 py-2 transition-all",
          isEndLive
            ? "border-border/30 bg-muted/30 cursor-not-allowed opacity-50"
            : isActive
              ? "border-primary ring-1 ring-primary/30 bg-primary/5 cursor-pointer"
              : "border-border/50 hover:border-border cursor-pointer",
        )}
        onClick={() => {
          if (!isEndLive) setActiveField(field);
        }}
      >
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label={label}
            className={cn(
              "h-7 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0",
              isEndLive && "pointer-events-none",
            )}
            value={fmtDate(ts)}
            onChange={(e) => {
              if (isEndLive) return;
              const next = parseDateInput(ts, e.target.value);
              setTs(next);
              const d = fromTs(next);
              setDisplayMonth(new Date(d.getFullYear(), d.getMonth(), 1));
              setError(null);
            }}
            onFocus={() => {
              if (!isEndLive) setActiveField(field);
            }}
            readOnly={isEndLive}
          />
          <Input
            type="time"
            step={60}
            className={cn(
              "h-7 w-[90px] flex-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0",
              isEndLive && "pointer-events-none",
            )}
            value={fmtTime(ts)}
            onChange={(e) => {
              if (isEndLive) return;
              setTs(parseTimeInput(ts, e.target.value));
              setError(null);
            }}
            onFocus={() => {
              if (!isEndLive) setActiveField(field);
            }}
            readOnly={isEndLive}
          />
        </div>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={selection.preset === "custom" ? "default" : "outline"}
          className="h-9 w-[100px] justify-start gap-1.5 text-xs"
          title={triggerLabel}
        >
          <CalendarDays className="h-4 w-4 shrink-0" />
          <span className="truncate flex-1">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="usage-range-popover w-[620px] max-w-[calc(100vw-2rem)] p-3"
        align="end"
      >
        {/* 预设快捷按钮 */}
        <div className="flex flex-wrap gap-1.5 border-b border-border/40 pb-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="sm"
              variant={selection.preset === preset ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                onApply({ preset });
                setOpen(false);
              }}
            >
              {getUsageRangePresetLabel(preset)}
            </Button>
          ))}
        </div>

        <div className="usage-range-layout flex flex-col gap-3">
          {/* 左侧:日期字段 */}
          <div className="usage-range-fields space-y-2">
            <p className="text-xs text-muted-foreground">{L10N.customRangeHint}</p>
            {renderField("start")}
            {renderField("end")}

            <label className="flex cursor-pointer select-none items-center gap-2">
              <Checkbox
                checked={draftLiveEnd}
                onCheckedChange={(checked) => {
                  const live = checked === true;
                  setDraftLiveEnd(live);
                  if (live) {
                    setDraftEnd(Math.floor(Date.now() / 1000));
                    setActiveField("start");
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">{L10N.liveEndTime}</span>
            </label>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={() => setOpen(false)}
              >
                {L10N.cancel}
              </Button>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                onClick={handleApply}
              >
                {L10N.confirm}
              </Button>
            </div>
          </div>

          {/* 右侧:日历 */}
          <div className="usage-range-calendar rounded-lg border border-border/50 bg-muted/30 p-2.5">
            {/* 月份导航 */}
            <div className="mb-1.5 flex items-center justify-between">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() =>
                  setDisplayMonth(
                    new Date(
                      displayMonth.getFullYear(),
                      displayMonth.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <button
                type="button"
                className="text-sm font-medium transition-colors hover:text-primary"
                onClick={goToToday}
                title="当天"
              >
                {displayMonth.getFullYear()}年{displayMonth.getMonth() + 1}月
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() =>
                  setDisplayMonth(
                    new Date(
                      displayMonth.getFullYear(),
                      displayMonth.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* 星期表头 */}
            <div className="mb-0.5 grid grid-cols-7 text-center text-[11px] text-muted-foreground">
              {weekdayLabels.map((label, i) => (
                <div key={i} className="py-0.5">
                  {label}
                </div>
              ))}
            </div>

            {/* 日网格 */}
            <div className="grid grid-cols-7 gap-px">
              {calendarDays.map((day) => {
                const isCurrentMonth = day.getMonth() === displayMonth.getMonth();
                const isToday = isSameDay(day, today);
                const isStart = isSameDay(day, startDay);
                const isEnd = isSameDay(day, endDay);
                const dayStart = startOfDay(day);
                const inRange =
                  dayStart >= startOfDay(startDay) &&
                  dayStart <= startOfDay(endDay);
                const isEndpoint = isStart || isEnd;

                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    aria-label={day.toLocaleDateString("zh-CN")}
                    aria-current={isToday ? "date" : undefined}
                    aria-pressed={isEndpoint}
                    className={cn(
                      "relative h-7 rounded text-xs transition-colors",
                      !isCurrentMonth && "text-muted-foreground/30",
                      isCurrentMonth && !inRange && "hover:bg-muted",
                      inRange && !isEndpoint && "bg-primary/10 text-primary",
                      isEndpoint && "bg-primary font-medium text-primary-foreground",
                      isToday && !isEndpoint && "ring-1 ring-primary/40",
                    )}
                    onClick={() => handleDatePick(day)}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: 运行验证通过**

Run（仓库根）: `pnpm test:unit UsageDateRangePicker` 与 `pnpm typecheck`
Expected: PASS（4 个测试）+ typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/UsageDateRangePicker.tsx src/components/__tests__/UsageDateRangePicker.test.tsx
git commit -m "feat(ui): 移植 cc-switch 趋势日期选择器(预设+日历+live-end)"
```

---

### Task 5: 日志页集成（项 5）

**Files:**
- Modify: `src/pages/LogsPage.tsx`
- Test: `src/pages/__tests__/LogsPage.test.tsx`

**Interfaces:**
- Consumes: T2 的 `resolveUsageRange`/`getUsageRangePresetLabel`/`UsageRangeSelection`；T4 的 `UsageDateRangePicker`。
- Produces: LogsPage 过滤器栏出现日期范围选择器（默认 `{ preset: "7d" }`），`filter.after/before` 由 `onRangeApply` 驱动。
- 影响：`filter.after/before` 默认不再为 `undefined`（初始 7d 窗口）。

- [ ] **Step 1: 改页面实现**

修改 `src/pages/LogsPage.tsx`：

1. 第 4 行类型导入追加 `UsageRangeSelection`：
```ts
import type { ApiKey, Channel, LogFilter, LogStats, RequestLog, SecurityFinding, TimeBucket, UsageRangeSelection } from "../types";
```
2. 追加导入：
```ts
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import { UsageDateRangePicker } from "../components/UsageDateRangePicker";
```
3. 删除 `dateToSeconds`（当前第 84-87 行）与 `formatDateInput`（当前第 94-101 行）；**保留 `dateToEndOfDaySeconds`**（`onDeleteBefore` 在第 350 行使用）。
4. 模块级新增初始 filter 工厂（放在 `dateToEndOfDaySeconds` 之后）：
```ts
// 初始 7d 窗口:默认聚焦近一周,选择器可随时扩大/自定义
function initialFilter(): LogFilter {
  const r = resolveUsageRange({ preset: "7d" });
  return { after: r.startDate, before: r.endDate };
}
```
5. 第 252 行改为：
```ts
const [filter, setFilter] = useState<LogFilter>(initialFilter);
```
6. 新增 state（放在 `dimension` state 附近）：
```ts
const [rangeSel, setRangeSel] = useState<UsageRangeSelection>({ preset: "7d" });
const rangeLabel = getUsageRangePresetLabel(rangeSel.preset);
```
7. 新增 handler（放在 `onSearch` 定义之后）：
```ts
const onRangeApply = (sel: UsageRangeSelection) => {
  setRangeSel(sel);
  const r = resolveUsageRange(sel);
  updateFilter({ after: r.startDate, before: r.endDate });
  onSearch();
};
```
8. 删除两个原生日期 Input（当前第 458-471 行），替换为：
```tsx
<UsageDateRangePicker
  selection={rangeSel}
  onApply={onRangeApply}
  triggerLabel={rangeLabel}
/>
```

- [ ] **Step 2: 更新测试**

修改 `src/pages/__tests__/LogsPage.test.tsx`：

1. 把「时间跨度 ≤48h 时 bucketSecs 为 3600，否则为 86400」整块替换为（用选择器交互；默认 7d>48h → 86400；切 1d → 3600；切回 7d → 86400）：

```tsx
it("时间跨度 ≤48h 时 bucketSecs 为 3600，否则为 86400", async () => {
  render(<LogsPage />);
  await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeInTheDocument());
  // 默认 7d(>48h) → 按天
  expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400");

  // 打开选择器,选 1d(≤48h) → 3600
  fireEvent.click(screen.getByRole("button", { name: /7d/ }));
  fireEvent.click(await screen.findByRole("button", { name: "1d" }));
  await waitFor(() =>
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "3600")
  );

  // 打开选择器,选 7d(>48h) → 86400
  fireEvent.click(screen.getByRole("button", { name: /1d/ }));
  fireEvent.click(await screen.findByRole("button", { name: "7d" }));
  await waitFor(() =>
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400")
  );
});
```

2. 追加一个默认范围断言测试：

```tsx
it("默认 7d 范围:listLogs 携带 after/before 且跨度约 7 天", async () => {
  render(<LogsPage />);
  await waitFor(() => expect(mockedApi.listLogs).toHaveBeenCalled());
  const call = mockedApi.listLogs.mock.calls[0][0];
  expect(call.after).toBeDefined();
  expect(call.before).toBeDefined();
  expect(call.before! - call.after!).toBeGreaterThan(6 * 86400);
  expect(call.before! - call.after!).toBeLessThan(7 * 86400 + 3600);
});
```

注：其余既有测试（keyword 联动、统计卡片、会话分组等）不受影响——`listLogs`/`getLogStats`/`getLogTimeseries` 的 `expect.objectContaining` 断言与新增的 `after/before` 兼容。

- [ ] **Step 3: 运行验证通过**

Run（仓库根）: `pnpm test:unit LogsPage` 与 `pnpm typecheck`
Expected: PASS + typecheck 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/pages/LogsPage.tsx src/pages/__tests__/LogsPage.test.tsx
git commit -m "feat(logs): 日志页用 cc-switch 式日期范围选择器替换原生日期输入,默认 7d"
```

---

### Task 6: 概览页趋势集成（项 5）

**Files:**
- Modify: `src/pages/DashboardPage.tsx`
- Test: `src/pages/__tests__/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: T2 的 `resolveUsageRange`/`getUsageRangePresetLabel`/`UsageRangeSelection`；T4 的 `UsageDateRangePicker`。
- Produces: 概览「今日趋势」卡 Header 出现选择器（默认 `{ preset: "today" }`），趋势随 `rangeSel` 重拉，bucket 自适应。

- [ ] **Step 1: 改页面实现**

修改 `src/pages/DashboardPage.tsx`：

1. 第 3 行类型导入追加 `UsageRangeSelection`：
```ts
import type { Stats, TimeBucket, UsageRangeSelection } from "../types";
```
2. 追加导入：
```ts
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import { UsageDateRangePicker } from "../components/UsageDateRangePicker";
```
3. 删除 `TREND_BUCKET_SECS` 与 `TREND_WINDOW_SECS` 常量（当前第 17-20 行），保留 `DIMENSION_TABS`。
4. 组件内 state 与 effect 改写：

```tsx
export default function DashboardPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [buckets, setBuckets] = useState<TimeBucket[] | null>(null);
  const [bucketSecs, setBucketSecs] = useState(3600);
  const [dimension, setDimension] = useState<Dimension>("calls");
  const [rangeSel, setRangeSel] = useState<UsageRangeSelection>({ preset: "today" });

  useEffect(() => {
    api.getStats().then(setS).catch(console.error);
  }, []);

  useEffect(() => {
    const r = resolveUsageRange(rangeSel);
    const bs = r.endDate - r.startDate <= 48 * 3600 ? 3600 : 86400;
    setBucketSecs(bs);
    api
      .getLogTimeseries({ after: r.startDate, before: r.endDate }, bs)
      .then(setBuckets)
      .catch(console.error);
  }, [rangeSel]);
  ...
```

5. 渲染处（`cards` 之后）加 `const rangeLabel = getUsageRangePresetLabel(rangeSel.preset);`
6. CardHeader 加选择器（把维度 tab 包进一个 flex 容器）：

```tsx
<CardHeader className="flex flex-row items-center justify-between pb-2">
  <CardTitle className="text-base">今日趋势</CardTitle>
  <div className="flex items-center gap-3">
    <UsageDateRangePicker
      selection={rangeSel}
      onApply={setRangeSel}
      triggerLabel={rangeLabel}
    />
    <div className="flex gap-1 text-sm" role="tablist" aria-label="趋势维度">
      {DIMENSION_TABS.map((tab) => (
        <button key={tab.value} role="tab" aria-selected={dimension === tab.value}
          onClick={() => setDimension(tab.value)}
          className={`rounded-md px-2 py-1 transition-colors ${
            dimension === tab.value
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}>
          {tab.label}
        </button>
      ))}
    </div>
  </div>
</CardHeader>
```

7. 图表处 `bucketSecs={TREND_BUCKET_SECS}` 改为 `bucketSecs={bucketSecs}`。

- [ ] **Step 2: 更新测试**

修改 `src/pages/__tests__/DashboardPage.test.tsx`：

1. 把「挂载时请求 getStats 与 getLogTimeseries(今日时间窗, 3600)」改为断言当天 0 点→now：

```tsx
it("挂载时请求 getStats 与 getLogTimeseries(当天 0 点 → now, 3600)", async () => {
  render(<DashboardPage />);
  await waitFor(() => expect(mockedApi.getStats).toHaveBeenCalled());
  const [filter, bucketSecs] = mockedApi.getLogTimeseries.mock.calls[0];
  expect(bucketSecs).toBe(3600);
  const now = new Date();
  const expectedAfter = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  );
  expect(filter.after).toBeDefined();
  expect(Math.abs((filter.after ?? 0) - expectedAfter)).toBeLessThan(5);
  expect(filter.before).toBeDefined();
  expect(Math.abs((filter.before ?? 0) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
});
```

2. 追加「选择 30d 预设 → 按天 bucket 重新拉取趋势」：

```tsx
it("选择 30d 预设 → 按天 bucket 重新拉取趋势", async () => {
  render(<DashboardPage />);
  await waitFor(() => expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: /当天/ }));
  fireEvent.click(await screen.findByRole("button", { name: "30d" }));

  await waitFor(() => expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(2));
  const [filter, bucketSecs] = mockedApi.getLogTimeseries.mock.calls[1];
  expect(bucketSecs).toBe(86400);
  const now = new Date();
  const expectedAfter = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime() / 1000
  );
  expect(Math.abs((filter.after ?? 0) - expectedAfter)).toBeLessThan(5);
});
```

注：既有「无趋势数据时展示空状态」测试中 `mockedApi.getLogTimeseries.mockResolvedValue([])` 仍适用；「趋势图以 hourly bucket 渲染并支持维度切换」的 `data-bucket-secs="3600"` 断言仍成立（默认 today ≤48h）。

- [ ] **Step 3: 运行验证通过**

Run（仓库根）: `pnpm test:unit DashboardPage` 与 `pnpm typecheck`
Expected: PASS + typecheck 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/pages/DashboardPage.tsx src/pages/__tests__/DashboardPage.test.tsx
git commit -m "feat(dashboard): 今日趋势加 cc-switch 式日期范围选择,默认当天,自适应 bucket"
```

---

### Task 7: CLAUDE.md 更新 + 全量验证

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: T1-T6 的产出（新模块/组件名、写盘行为）。

- [ ] **Step 1: 更新 CLAUDE.md**

1. `cli_config` 段（architecture 列表项）改为只写 settings.json：
```
- `cli_config`: writes Claude Code (`~/.claude/settings.json` — only the `env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_AUTH_TOKEN` vars) and Codex (`~/.codex/config.toml`) configuration so local CLI tools point at the gateway.
```
2. Frontend 段追加一行（放在 `src/lib/api.ts` 那行附近）：
```
- `src/lib/usageRange.ts` + `src/components/UsageDateRangePicker.tsx`: cc-switch-style trend date-range selection (presets 当天/1d/7d/14d/30d + custom calendar with live end) used by the Logs page (default 7d) and Dashboard trend (default today).
```

- [ ] **Step 2: 全量前端验证**

Run（仓库根）: `pnpm typecheck` 与 `pnpm test:unit`
Expected: 全绿（原有 135 + 新增 usageRange 8 + picker 4，LogsPage/DashboardPage 更新后通过）。

- [ ] **Step 3: 全量后端验证**

Run（在 `src-tauri/`）: `NO_PROXY=127.0.0.1,localhost cargo test`
Expected: 全绿（lib 354 增减 + 全部集成测试；`NO_PROXY` 为本机代理规避，spec 已知问题）。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 记录日期范围选择器与 CLI 写盘严格化"
```

---

## Self-Review

**Spec 覆盖核对：**
- 项 6 严格化（settings.json 两变量、不写 .claude.json、两条路径、删死代码与测试）→ T1。
- 项 5 usageRange.ts（类型/语义/live-end/中文标签）→ T2。
- 项 5 UsageDateRangePicker（预设+日历+时间+live-end、Popover、container 布局）→ T3（基建）+ T4。
- 项 5 日志页（默认 7d、替换输入、删除死代码精确：保留 `dateToEndOfDaySeconds`）→ T5。
- 项 5 概览页（默认 today、自适应 bucket、移除 TREND_* 常量）→ T6。
- CLAUDE.md 更新 + 全量验证 → T7。
- spec 3.6 补的 `commands/cli.rs` 范围 → T1。

**占位符扫描：** 无 TBD/TODO；每个代码步骤含完整代码。

**类型一致性：** `UsageRangePreset`/`UsageRangeSelection` 定义于 T2 的 `src/types/index.ts`，T2/T4/T5/T6 一致引用；`resolveUsageRange(selection, nowMs?)` 签名在 T2 定义、T4/T5/T6 按 `resolveUsageRange(sel)` 调用（省略可选参数，合法）；`getUsageRangePresetLabel(preset)` 无 `t` 参数（比 cc-switch 少一个，本仓库无 i18n）。`UsageDateRangePicker` 具名导出，T5/T6 import 一致。
