# UI 重设计（方向 A · 青碧信号）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps start as `- [ ] **Step N: ...**`; mark only actually completed steps `- [X] **Step N: ...**`.

**Goal:** 用青碧信号设计令牌系统统一全部页面外观，补齐真暗色模式与主题切换，重排日志/概览/渠道/设置四页结构，并在顶栏展示网关运行状态。

**Architecture:** 先建令牌层与主题逻辑（Task 1–2），再建三个共享组件（Task 3–4），随后重写布局骨架（Task 5），最后逐页迁移（Task 6–10），硬编码色收敛检查作为收尾测试。所有颜色经 CSS 变量一处定义，组件与页面只引用令牌。

**Tech Stack:** React 18 + TypeScript + Tailwind CSS（CSS 变量扩展）+ Vitest/Testing Library + Tauri v2（前端侧 plugin-store）。

**Spec:** `docs/specs/2026-10-18-ui-redesign-direction-a-teal/spec.md`

**Design:** `.mulix/.runtime/2026-10-18-ui-redesign-direction-a-teal/specs/2026-10-18-ui-redesign-design.md`（同文存于 `docs/superpowers/specs/2026-10-18-ui-redesign-design.md`）

## Global Constraints

- 界面代码（`src/**/*.tsx`）禁止硬编码调色板色类（`text-red-500` 之类）；颜色一律来自令牌；`ui/` 原语源码不改。
- 青碧 `#3ECFBB` 只进 `--primary`/`--ring`；`--accent` 保持中性灰。
- Rust 侧零改动：`git diff src-tauri/` 全程为空（capabilities 配置文件除外，若 plugin-store 授权需要）。
- 主题三态：`light | dark | system`，默认 `system`。
- 暗色令牌值（HSL，精确值见设计文档表）：background `#0C1216`、surface `#0A0F12`、card `#0E161A`、border `#16242A`、foreground `#C7DCDF`、muted `#7D949A`、faint `#4D666D`、primary `#3ECFBB`、success `#57C98B`、warning `#E0B05E`、danger `#E07A6B`、info `#6FB7E8`。
- 数据字体 `"Cascadia Code", Consolas, monospace`（`--font-mono`）；数值 `tabular-nums`、右对齐。
- 中文 UI 文案；键盘焦点环可见（primary 色）；`prefers-reduced-motion` 时状态点动画静止。
- 每个任务结束：`pnpm typecheck` 与 `pnpm test:unit` 全绿后**原子提交**——仅显式 `git add <本任务文件>`，禁止 `git add .`；不 push；不带入仓库无关改动。

## Review Focus

- 网关未运行/绑定失败时顶栏必须显示红色状态而非报错或空白（Task 5 `gatewayStatus` 单测钉住）。
- 主题"跟随系统"下系统偏好变化必须即时切换且监听被正确清理（Task 1 单测钉住）。
- 浅色模式下青碧在正文上的对比度 ≥ 4.5:1（实现时用对比度脚本/工具校验并记录定稿值；属人工验收项）。
- 风险 6 级在两个主题下的图表系列色必须两两可辨（Task 6 `chartColors` 单测钉住映射，明度人工目检）。
- 既有页面测试若断言旧类名/结构，迁移后必须按新组件语义更新断言，禁止删测试来变绿。

---

## Task 1: 设计令牌层与主题逻辑

**Files:**
- Modify: `src/index.css`（重写令牌段）
- Modify: `tailwind.config.cjs`（新增 success/warning/info/faint/surface、fontFamily.mono）
- Create: `src/lib/theme.ts`
- Test: `src/lib/__tests__/theme.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export type ThemeMode = "light" | "dark" | "system"`
  - `export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark"`
  - `export function applyTheme(mode: ThemeMode): void`（挂/摘 `document.documentElement.classList` 的 `dark`）
  - `export function subscribeSystemTheme(cb: () => void): () => void`
  - Tailwind 类：`bg-surface`、`text-success/warning/info/faint`、`font-mono`。
  - CSS 变量名沿用 shadcn 命名（`--background/--card/--border/--primary/--ring/--muted/--destructive` 等）+ 新增 `--surface/--success/--warning/--info/--faint`。

- [X] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/theme.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveTheme, applyTheme, subscribeSystemTheme } from "../theme";

afterEach(() => document.documentElement.classList.remove("dark"));

describe("resolveTheme", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)("%s + systemDark=%s → %s", (mode, sysDark, want) => {
    expect(resolveTheme(mode, sysDark)).toBe(want);
  });
});

describe("applyTheme", () => {
  it("mounts and unmounts the dark class", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("subscribeSystemTheme", () => {
  it("invokes callback on change and unsubscribes", () => {
    const cb = vi.fn();
    const unsub = subscribeSystemTheme(cb);
    window.dispatchEvent(new Event("change")); // matchMedia mock provides this
    expect(cb).toHaveBeenCalled();
    unsub();
  });
});
```

（测试环境用 `vi.stubGlobal("matchMedia", ...)` 提供 `{ matches: false, addEventListener, removeEventListener }` 的假对象。）

- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/theme.test.ts`
Expected: FAIL with "Cannot find module '../theme'"

- [X] **Step 3: Implement `src/lib/theme.ts` 按上述签名；重写 `src/index.css` 令牌段与 `tailwind.config.cjs` 映射**

- `:root` 浅色、`.dark` 暗色两段 HSL 变量（值按 Global Constraints 表换算 HSL）；`--font-mono` 定义。
- 现有 `usage-range` 容器查询保留；现有散落 `dark:` 类暂不动（Task 10 清理）。

- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/theme.test.ts`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/lib/theme.ts src/lib/__tests__/theme.test.ts src/index.css tailwind.config.cjs
git commit -m "feat(ui): 青碧信号设计令牌层与主题逻辑"
```

## Task 2: 主题持久化（plugin-store + 降级）

**Files:**
- Modify: `package.json`、`src/lib/theme.ts`
- Create: `src-tauri/capabilities/default.json`（若现有 capabilities 文件已存在则 Modify）
- Test: `src/lib/__tests__/theme.test.ts`（追加持久化用例）

**Interfaces:**
- Consumes: Task 1 的 `applyTheme/resolveTheme`。
- Produces: `export function loadThemeMode(): ThemeMode | null`、`export function saveThemeMode(m: ThemeMode): Promise<void>`——优先 `@tauri-apps/plugin-store`（store 文件 `store.bin`，key `"theme"`），任何异常降级 `localStorage`（key `"theme"`）。

- [X] **Step 1: Write the failing test**——mock `@tauri-apps/plugin-store` 的 `load/Store.get/set`：save 成功走 store；store 抛错时写入 localStorage。断言两条路径。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/theme.test.ts`
Expected: FAIL with "loadThemeMode is not exported"

- [X] **Step 3: Implement** `loadThemeMode/saveThemeMode`（内部 try/catch 降级）；`pnpm add @tauri-apps/plugin-store`；在 capabilities 文件授予 `store:default`（或最小 get/set 权限）。若 capability 授权流程被阻塞，改为纯 localStorage 实现并在提交信息中注明降级。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/theme.test.ts`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/theme.ts src/lib/__tests__/theme.test.ts src-tauri/capabilities/
git commit -m "feat(ui): 主题三态持久化（plugin-store，降级 localStorage）"
```

## Task 3: StatusBadge 与语义映射

**Files:**
- Create: `src/components/StatusBadge.tsx`
- Create: `src/lib/semantics.ts`
- Test: `src/components/__tests__/StatusBadge.test.tsx`

**Interfaces:**
- Consumes: Tailwind 类 `text-success/warning/danger/info/faint` 及其 `bg-*/10`。
- Produces:
  - `export type Semantic = "success" | "warning" | "danger" | "info" | "neutral"`
  - `export function StatusBadge({ semantic, children, className }: { semantic: Semantic; children: React.ReactNode; className?: string })`
  - `export function httpStatusSemantic(code: number): Semantic`（2xx→success，429→warning，其余 4xx/5xx→danger）
  - `export function riskSemantic(level: string): Semantic`（clean→neutral，info→info，low→success，medium→warning，high/critical→danger，未知→neutral；大小写不敏感）

- [X] **Step 1: Write the failing test**——五变体渲染断言（success→`text-success` 等）；`httpStatusSemantic` 断言 200/204→success、429→warning、400/500→danger；`riskSemantic` 断言上述全表（含 `"Clean"` 大小写、未知值→neutral）。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/StatusBadge.test.tsx`
Expected: FAIL with "Cannot find module '../../components/StatusBadge'"

- [X] **Step 3: Implement** `src/lib/semantics.ts`（两个纯映射函数）与 `src/components/StatusBadge.tsx`（cva 五变体：语义色文字 + 同色 10% 底 + 圆角 4px）。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/StatusBadge.test.tsx`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/components/StatusBadge.tsx src/lib/semantics.ts src/components/__tests__/StatusBadge.test.tsx
git commit -m "feat(ui): StatusBadge 组件与语义映射"
```

## Task 4: StatCard 与 SegmentedTabs

**Files:**
- Create: `src/components/StatCard.tsx`、`src/components/SegmentedTabs.tsx`
- Test: `src/components/__tests__/StatCard.test.tsx`、`src/components/__tests__/SegmentedTabs.test.tsx`

**Interfaces:**
- Consumes: Tailwind `font-mono`、`tabular-nums`、`text-primary`、`bg-primary/10`。
- Produces:
  - `export function StatCard({ label, value, hint, progress }: { label: string; value: string; hint?: string; progress?: number })`——value 用 `font-mono tabular-nums text-2xl`；`progress`（0–100）渲染 `bg-primary` 进度条。
  - `export function SegmentedTabs<T extends string>({ value, onChange, options, ariaLabel }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; ariaLabel?: string })`——选中项左侧 2px primary 竖条 + `bg-primary/10`；`role="tablist"/"tab"` + `aria-selected`；支持方向键切换。

- [X] **Step 1: Write the failing test**——StatCard：label/value/hint/progress 渲染、value 含 `tabular-nums`；SegmentedTabs：受控切换回调、`aria-selected`、方向键改变选中并触发 onChange。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/StatCard.test.tsx src/components/__tests__/SegmentedTabs.test.tsx`
Expected: FAIL with "Cannot find module"

- [X] **Step 3: Implement** 两组件。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/StatCard.test.tsx src/components/__tests__/SegmentedTabs.test.tsx`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/components/StatCard.tsx src/components/SegmentedTabs.tsx src/components/__tests__/StatCard.test.tsx src/components/__tests__/SegmentedTabs.test.tsx
git commit -m "feat(ui): StatCard 与 SegmentedTabs 共享组件"
```

## Task 5: 布局骨架（分组侧边栏 + 顶栏网关状态）

**Files:**
- Modify: `src/components/Layout.tsx`（重写）
- Create: `src/lib/gatewayStatus.ts`
- Test: `src/components/__tests__/Layout.test.tsx`

**Interfaces:**
- Consumes: Task 1 令牌；`api.getAppConfig()`（现有，返回含 `bound_addr: string | null`）。
- Produces:
  - `export function gatewayStatus(boundAddr?: string | null): { semantic: "success" | "danger"; label: string; port?: string }`——非空→`{ semantic: "success", label: "网关运行中", port: ":8778" 形式 }`；空/null/undefined→`{ semantic: "danger", label: "网关未运行" }`。
  - 布局导出导航分组常量 `NAV_GROUPS`（运行/配置/能力 + 系统沉底），供测试断言。
  - 页面刷新时 `window.dispatchEvent(new CustomEvent("gateway-refresh"))`（Task 6/7 在各自刷新逻辑中触发），Layout 监听后重新拉取 `getAppConfig`。

- [X] **Step 1: Write the failing test**——`gatewayStatus`：`"127.0.0.1:8778"`→success+port、`null/""/undefined`→danger 无 port；Layout 渲染：三组标题 + 8 个入口链接 + 设置在分组外沉底；监听 `gateway-refresh` 后重新调用 getAppConfig。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/Layout.test.tsx`
Expected: FAIL with "Cannot find module '../../lib/gatewayStatus'"

- [X] **Step 3: Implement**——`gatewayStatus.ts`；重写 Layout：分组侧边栏（选中态 = 左 2px primary 竖条 + `bg-primary/10`）、顶栏（`lg·gateway` 字标 + 状态点 `animate-pulse`、`motion-reduce:animate-none` + 等宽端口）、`<main>` 内容 `max-w-[1440px] mx-auto`。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/Layout.test.tsx`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/components/Layout.tsx src/lib/gatewayStatus.ts src/components/__tests__/Layout.test.tsx
git commit -m "feat(ui): 分组侧边栏与顶栏网关状态"
```

## Task 6: 图表系列色 + 概览页

**Files:**
- Create: `src/lib/chartColors.ts`
- Modify: `src/components/LogTrendChart.tsx`（色值改由 `chartColors` 提供）
- Modify: `src/pages/DashboardPage.tsx`
- Test: `src/lib/__tests__/chartColors.test.tsx`

**Interfaces:**
- Consumes: Task 3 `riskSemantic`、Task 4 `StatCard/SegmentedTabs`；CSS 变量经 `getComputedStyle` 读取。
- Produces:
  - `export function seriesColor(dim: Dimension, key: string): string`——返回 `var(--...)` 形式 CSS 色：非语义维度 primary/info/中性灰；token 维度 input=`var(--muted-foreground)`、output=`var(--primary)`、cache_read=`var(--info)`、cache_creation=`var(--warning)`；risk 维度按 `riskSemantic`（danger 两档：high 用 `color-mix` 降 20% 不透明度实现）。风险/成功率维度超出映射的 key 回退中性灰。
  - DashboardPage：统计卡两行改 `StatCard`；新增"Top 渠道/Top 密钥"两卡（数据源 `api.getStats()` 的 `top_channels/top_api_keys`）；趋势卡 tabs 换 `SegmentedTabs`；缓存命中率进度条 `bg-primary`。
  - DashboardPage 刷新时 dispatch `gateway-refresh`。

- [X] **Step 1: Write the failing test**——`seriesColor("tokens","input")`→含 `--muted-foreground`、`("tokens","output")`→`--primary`、`("risk","critical")`→danger 变量、`("risk","unknown-key")`→中性、`("calls","main")`→primary；未知维度回退中性。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/chartColors.test.tsx`
Expected: FAIL with "Cannot find module '../chartColors'"

- [X] **Step 3: Implement** `chartColors.ts`；LogTrendChart 全部取色点改为 `seriesColor`；DashboardPage 按 Produces 重排（Top 榜 UI 从 LogsPage 的现实现复制结构，LogsPage 侧在 Task 7 删除）。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/chartColors.test.tsx && pnpm vitest run src/pages/__tests__`
Expected: PASS（页面既有测试若因结构更新断言，按新组件语义修正断言）

- [X] **Step 5: Commit**

```bash
git add src/lib/chartColors.ts src/lib/__tests__/chartColors.test.tsx src/components/LogTrendChart.tsx src/pages/DashboardPage.tsx
git commit -m "feat(ui): 图表语义系列色与概览页改版"
```

## Task 7: 日志与会话页改版

**Files:**
- Modify: `src/pages/LogsPage.tsx`
- Test: `src/pages/__tests__/`（既有文件，按需更新断言 + 新增统计带断言）

**Interfaces:**
- Consumes: Task 3 `StatusBadge/httpStatusSemantic/riskSemantic`、Task 4 `StatCard/SegmentedTabs`；Task 6 后 Top 榜已迁至概览。
- Produces: 统计带（总调用/成功率/Token/费用，单行等宽）；表格行高 ~36px、等宽模型名、数字列右对齐；HTTP 状态与风险列用 `StatusBadge`；原生 `<select>` 换 shadcn Select（或统一 select 样式，实现者定其一并全页一致）；日志清理区收进折叠/次要样式；刷新时 dispatch `gateway-refresh`。

- [X] **Step 1: Write the failing test**——渲染含 stats 数据的页面：统计带存在且含 4 项；风险徽章元素含 StatusBadge 的语义类（如 `text-success`）；Top 渠道/Top 密钥不再渲染。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__ -t Logs`
Expected: FAIL（统计带断言不满足）

- [X] **Step 3: Implement** 按 Produces 重排页面；删除 Top 榜与重复统计卡。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/pages/__tests__`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/pages/LogsPage.tsx src/pages/__tests__/
git commit -m "feat(ui): 日志页表格主体化与统计带"
```

## Task 8: 渠道页改版

**Files:**
- Modify: `src/pages/ChannelsPage.tsx`
- Test: `src/pages/__tests__/`（既有文件按需更新断言）

**Interfaces:**
- Consumes: Task 3 `StatusBadge`、Task 4 `SegmentedTabs`、Task 1 令牌。
- Produces: 删除蓝色渐变左侧条；启用渠道 = `success` 状态点 + 中性角色标签（`bg-card`/`font-mono`，不再 per-角色彩色）；延迟常驻（success 色）；停用渠道 `opacity-55` + "已停用"标签；状态筛选换 `SegmentedTabs`；**删除 `hover:border-border-active` 死类**，hover 边框改 `hover:border-primary/40`。

- [X] **Step 1: Write the failing test**——渲染渠道卡：启用卡含 `text-success` 状态点与延迟文本；停用卡含 "已停用"；页面源码不含 `border-border-active` 与渐变类（`bg-gradient-to-b`）。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__ -t Channel`
Expected: FAIL

- [X] **Step 3: Implement** 按 Produces 改造。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/pages/__tests__`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/pages/ChannelsPage.tsx src/pages/__tests__/
git commit -m "feat(ui): 渠道页状态点化并修复 hover 边框"
```

## Task 9: 设置页分组面板 + 外观分组

**Files:**
- Modify: `src/pages/SettingsPage.tsx`
- Test: `src/pages/__tests__/`（按需更新断言）

**Interfaces:**
- Consumes: Task 1/2 `useTheme/loadThemeMode/saveThemeMode`、Task 4 `SegmentedTabs`。
- Produces:
  - `useTheme` hook（在 Task 1 的 theme.ts 上补齐）：`{ mode, setMode }`，`setMode` 调 `applyTheme` + `saveThemeMode`。
  - 设置页布局：分组面板（组标题 + 行式布局，行左说明右控件）；"外观"组置顶，内含主题三态 `SegmentedTabs`；其余现有设置项（端口、数据管理等）迁入分组，功能不变。

- [X] **Step 1: Write the failing test**——`useTheme`：setMode("dark") 后 `documentElement` 含 `dark` 且 saveThemeMode 被调用（mock）；设置页渲染含"外观"标题与三态控件。
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__ -t Settings`
Expected: FAIL

- [X] **Step 3: Implement** hook 与页面重构。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/pages/__tests__`
Expected: PASS

- [X] **Step 5: Commit**

```bash
git add src/pages/SettingsPage.tsx src/lib/theme.ts src/lib/__tests__/theme.test.ts src/pages/__tests__/
git commit -m "feat(ui): 设置页分组面板与外观主题切换"
```

## Task 10: 其余页面收敛 + 硬编码色检查

**Files:**
- Modify: `src/pages/{ApiKeysPage,RoleRoutesPage,SecurityPage,KnowledgePage,PromptsPage,SkillsPage,McpServersPage,RecordsPage,ResourcesPage,SessionsPage}.tsx`
- Test: `src/tokens-guard.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `StatusBadge`、Task 4 组件、Task 1 令牌。
- Produces: 全部徽章走 `StatusBadge`（风险等级、密钥状态、MCP 状态等）；角色/provider 徽章改中性等宽文字；PageHeader/空态间距统一；全项目零硬编码调色板色。

- [X] **Step 1: Write the failing test**

```ts
// src/tokens-guard.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PALETTE = /(text|bg|border|ring|fill|stroke)-(red|green|emerald|amber|orange|purple|violet|blue|sky|cyan|pink|rose|lime|yellow|teal|indigo|fuchsia|slate|gray|zinc|neutral|stone)-\d+/;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p;
  });
}
describe("no hardcoded palette colors", () => {
  it("src tsx files contain none", () => {
    const offenders = walk("src").filter((p) => p.endsWith(".tsx"))
      .filter((p) => !p.includes(`${join("src", "components", "ui")}`))
      .filter((p) => PALETTE.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no dead dark: utilities", () => {
    const offenders = walk("src").filter((p) => p.endsWith(".tsx"))
      .filter((p) => /[\s"']dark:/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tokens-guard.test.ts`
Expected: FAIL，offenders 列出全部残留页

- [X] **Step 3: Implement**——逐页把徽章/彩色类替换为 StatusBadge 与令牌类；删除全部 `dark:` 死代码；`ui/` 目录豁免（保持原语不动）。
- [X] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/tokens-guard.test.ts && pnpm typecheck && pnpm test:unit`
Expected: 全部 PASS

- [X] **Step 5: Commit**

```bash
git add src/pages/ src/tokens-guard.test.ts
git commit -m "refactor(ui): 全页面颜色令牌化，清理 dark: 死代码"
```

## Task 11: 全量验证与浅色对比度校验

**Files:**
- Create: `docs/changes/2026-10-18-ui-redesign-direction-a-teal/light-mode-contrast.md`（对比度校验记录）
- Modify: `src/index.css`（仅当浅色对比度不达标时调整浅色 primary 定稿值）

- [X] **Step 1: 运行全量验证**

Run: `pnpm typecheck && pnpm test:unit && git diff --stat src-tauri/`
Expected: 全绿；`src-tauri/` 仅 capabilities 文件出现在 diff（或无 diff）

- [X] **Step 2: 浅色对比度校验**——对浅色 primary、success/warning/danger/info 文字色与 card/background 组合计算对比度（可用任意 WCAG 计算脚本），正文场景 ≥ 4.5:1；不达标的令牌调整并复跑 Task 10 检查与全量测试。结果记录到 `light-mode-contrast.md`（令牌名、色值、比值）。
- [ ] **Step 3: 人工两态目检**——`pnpm dev` 逐页过 14 页 × 明/暗，对照视觉稿与 spec 验收场景；发现问题当场修（小修并入本任务提交）。
- [X] **Step 4: Commit**

```bash
git add docs/changes/2026-10-18-ui-redesign-direction-a-teal/light-mode-contrast.md src/index.css
git commit -m "docs(ui): 浅色对比度校验记录与令牌定稿"
```
