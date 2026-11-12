# 合并页 tab 通栏化（对齐 cc-switch）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `RecordsPage` / `ResourcesPage` 两个合并页的 tab 标签改用 cc-switch 的通栏布局与样式（全宽等分、选中蓝底白字、灰底胶囊），并保持「固定头部」。

**Architecture:** 移植 cc-switch 的 `src/components/ui/tabs.tsx`（Radix Tabs），用 `TabsList` 的 `grid w-full grid-cols-N` 全宽等分 + `TabsTrigger` 的 `data-[state=active]:bg-blue-500` 蓝底白字；用 `sticky top-0 z-10` 包裹 `TabsList` 保持固定头部（内容仍在 `main` 内滚动，回归风险最小）。RecordsPage 保留 URL 查询驱动，ResourcesPage 保留 `useState`。

**Tech Stack:** React 18、TypeScript、Tailwind、Radix UI（`@radix-ui/react-tabs`，需新增依赖）。

**Spec:** `docs/superpowers/specs/2026-08-26-tabs-project-dimension-image-design.md`（子项目 A 部分）

## Global Constraints

- 依赖版本：`@radix-ui/react-tabs` 用 `^1.1.x`（与仓库现有 radix 版本风格一致）。
- 只新增 `src/components/ui/tabs.tsx` 并按下文源码移植；不改 `tailwind.config.cjs`（`extend.colors` 下默认 Tailwind `blue-500/600` 可用）。
- 不使用 cc-switch 的 `glass`（llm-gateway 无该 util）；用 `rounded-lg bg-muted p-1` 即可。
- 提交前运行 `pnpm typecheck`、`pnpm test:unit`；提交信息遵循 `fix(ui): ...`。

---

### Task 1: 移植 Radix Tabs 组件并接入两个合并页

**Files:**
- Modify: `package.json`（新增 `@radix-ui/react-tabs` 依赖）
- Create: `src/components/ui/tabs.tsx`
- Modify: `src/pages/RecordsPage.tsx`
- Modify: `src/pages/ResourcesPage.tsx`
- Modify (test): `src/pages/__tests__/RecordsPage.test.tsx`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces:
  - `src/components/ui/tabs.tsx` 导出 `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent`（Radix 封装，样式与 cc-switch 一致）。
  - `RecordsPage`：`<Tabs value={tab} onValueChange={(v)=>setTab(v as TabId)}>`，`tab` 为 `"logs"|"sessions"`。
  - `ResourcesPage`：`<Tabs value={tab} onValueChange={setTab}>`，`tab` 为 `"knowledge"|"prompts"|"mcp"|"skills"`。

- [ ] **Step 1: 新增依赖**

```bash
pnpm add @radix-ui/react-tabs@^1.1.3
```

- [ ] **Step 2: 创建 `src/components/ui/tabs.tsx`**

```tsx
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-1 rounded-md bg-muted p-1 text-muted-foreground",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex min-w-[120px] items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-blue-500 data-[state=active]:text-white data-[state=active]:shadow-sm dark:data-[state=active]:bg-blue-600 data-[state=inactive]:opacity-60 data-[state=inactive]:hover:opacity-100 data-[state=inactive]:hover:bg-muted/50",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
```

- [ ] **Step 3: 更新 `RecordsPage.test.tsx` 的 tab 查询角色（先改断言，跑通后进入 Step 4 改实现）**

把两处 `getByRole("button", { name: "日志" })` 改为 `getByRole("tab", { name: "日志" })`（Radix `TabsTrigger` 暴露 `role="tab"`）。为确认改动生效并保持 TDD，完整替换 `src/pages/__tests__/RecordsPage.test.tsx` 中的点击断言：

```tsx
fireEvent.click(screen.getByRole("tab", { name: "日志" }));
```

（第 74 行处。该文件其余断言不变：默认 `?tab` 缺省落日志、`?tab=sessions` 显示会话、携带 `session` 查询落日志并应用筛选。）

- [ ] **Step 4: 运行测试，确认当前实现会失败（因为旧实现是 `<button>`，无 `role="tab"`）**

Run: `pnpm test:unit -- src/pages/__tests__/RecordsPage.test.tsx`
Expected: 失败于 `Unable to find role "tab"`。

- [ ] **Step 5: 重构 `RecordsPage.tsx` 使用 `Tabs`**

```tsx
import { useSearchParams } from "react-router-dom";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

const TABS = [
  { id: "logs", label: "日志" },
  { id: "sessions", label: "会话" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function RecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabId = tabParam === "sessions" ? "sessions" : "logs";
  const setTab = (id: TabId) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", id);
    setSearchParams(next, { replace: true });
  };

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
      <div className="sticky top-0 z-10 mb-4">
        <TabsList className="grid w-full grid-cols-2 rounded-lg bg-muted p-1">
          <TabsTrigger value="logs">日志</TabsTrigger>
          <TabsTrigger value="sessions">会话</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="logs" className="mt-0">
        {tab === "logs" ? <LogsPage /> : null}
      </TabsContent>
      <TabsContent value="sessions" className="mt-0">
        {tab === "sessions" ? <SessionsPage /> : null}
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 6: 重构 `ResourcesPage.tsx` 使用 `Tabs`**

```tsx
import { useState } from "react";
import KnowledgePage from "./KnowledgePage";
import PromptsPage from "./PromptsPage";
import McpServersPage from "./McpServersPage";
import SkillsPage from "./SkillsPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

const TABS = [
  { id: "knowledge", label: "知识库" },
  { id: "prompts", label: "Prompt" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ResourcesPage() {
  const [tab, setTab] = useState<TabId>("knowledge");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
      <div className="sticky top-0 z-10 mb-4">
        <TabsList className="grid w-full grid-cols-4 rounded-lg bg-muted p-1">
          <TabsTrigger value="knowledge">知识库</TabsTrigger>
          <TabsTrigger value="prompts">Prompt</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="knowledge" className="mt-0">
        {tab === "knowledge" ? <KnowledgePage /> : null}
      </TabsContent>
      <TabsContent value="prompts" className="mt-0">
        {tab === "prompts" ? <PromptsPage /> : null}
      </TabsContent>
      <TabsContent value="mcp" className="mt-0">
        {tab === "mcp" ? <McpServersPage /> : null}
      </TabsContent>
      <TabsContent value="skills" className="mt-0">
        {tab === "skills" ? <SkillsPage /> : null}
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 7: 运行前端单元测试**

Run: `pnpm test:unit`
Expected: 全部通过（含更新后的 `RecordsPage.test.tsx`；`ResourcesPage` 无既有测试）。

- [ ] **Step 8: 运行类型检查**

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 9: 手动验证（可选，若有运行中的 `pnpm dev`）**

确认 `/logs` 与 `/knowledge` 的 tab 为通栏（4 列/2 列等分）、选中项蓝底白字、滚动时 tab 固定在头部。

- [ ] **Step 10: 提交**

```bash
git add package.json pnpm-lock.yaml src/components/ui/tabs.tsx src/pages/RecordsPage.tsx src/pages/ResourcesPage.tsx src/pages/__tests__/RecordsPage.test.tsx
git commit -m "fix(ui): 合并页 tab 改用 cc-switch 通栏样式（蓝高亮/灰胶囊）"
```

注：提交可能被项目门禁拦截，需先运行 `code-review`/验证以产生审查指纹（见会话已确认的门禁处理方式）。

---

## Self-Review 自查

- **Spec 覆盖**：子项目 A（tab 通栏化 + cc-switch 样式 + 固定头部）已完整覆盖（Task 1 全步骤）。
- **占位符**：无 TBD/TODO；每步含真实源码/命令。
- **类型一致**：`TabsList`/`TabsTrigger`/`TabsContent` 命名贯穿一致；`setTab` 用 `(v as TabId)` 适配 Radix `onValueChange: (string)=>void`。
- **风险**：`RecordsPage.test.tsx` 的 `role="tab"` 断言改动已在 Step 3/4 明示；`sticky` 方案在既有布局已验证可用。
