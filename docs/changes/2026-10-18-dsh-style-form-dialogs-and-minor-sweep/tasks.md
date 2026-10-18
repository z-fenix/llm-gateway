# DSH 式表单弹框交互 + minor 清零 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps start as `- [ ] **Step N: ...**`; mark only actually completed steps `- [X] **Step N: ...**`.

**Goal:** 全部表单弹框按 DSH 模型表单交互模式改造（折叠区/行内校验/禁用态应用/write-only 密钥），并清零上一 change 的全部遗留 minor。

**Architecture:** 先建三个共享表单原语（FormField/FormFooter/SecretInput，T1），再按表单逐个套用（T2–T4），随后两批 minor 清理（T5–T6），全量验证收尾（T7）。交互模式基准与字段划分见设计文档。

**Tech Stack:** React 18 + Tailwind（令牌）+ Vitest/Testing Library；Rust 侧仅 capabilities JSON 可改。

**Spec:** `docs/specs/2026-10-18-dsh-style-form-dialogs-and-minor-sweep/spec.md`

**Design:** `.mulix/.runtime/2026-10-18-dsh-style-form-dialogs-and-minor-sweep/specs/2026-10-18-dsh-form-design.md`

## Global Constraints

- 交互模式六要素（DSH 提炼）：主字段直显 + `<details>` 折叠区；页脚左取消右应用；busy 时取消禁用、应用文案「应用中」；行内错误（`role="alert"`）+ 校验不过禁用应用；SecretInput write-only（不回填/留空语义/去空白/reveal）；显式应用成功即关弹框。
- 各表单既有功能、命令调用、校验规则不变；Rust 仅 capabilities JSON 可改。
- 颜色一律令牌；`pnpm typecheck && pnpm test:unit` 每任务全绿。
- 原子提交：仅显式 `git add <本任务文件>`；不 push。
- DSH 参考源码（只读）：`\\wsl.localhost\Ubuntu-26.04\home\zhang\workplace\deepseek-harness\packages\client\ui-settings-models\src\client\`。

## Review Focus

- 渠道编辑留空密钥必须原样回传掩码值（不丢 key）——T2 用测试钉住（mock update_channel 断言 payload）。
- 折叠区内字段出错时应用禁用且 summary 行有错误提示——T2 钉住。
- SecretInput reveal 必须随值变更重置掩码——T1 钉住。
- capabilities 最小化后主题持久化仍可用（theme 持久化测试保持绿）——T6 钉住。

---

## Task 1: 共享表单原语（SecretInput / FormField / FormFooter）

**Files:**
- Create: `src/components/form/SecretInput.tsx`、`src/components/form/FormField.tsx`、`src/components/form/FormFooter.tsx`
- Test: `src/components/form/__tests__/form.test.tsx`（三组件一个文件）

**Interfaces:**
- Consumes: 令牌类（text-destructive/text-faint/border-input）。
- Produces:
  - `export function SecretInput({ value, onChange, saved, disabled, invalid, ariaLabel }: { value: string; onChange: (v: string) => void; saved?: string; disabled?: boolean; invalid?: boolean; ariaLabel: string })` —— password/text 切换 reveal；内部 `onChange(input.value.trim())`；reveal 态随 value 变化重置；`autoComplete="new-password"`；`aria-invalid={invalid}`；saved 作 placeholder。
  - `export function FormField({ label, htmlFor, error, hint, required, children }: { label: string; htmlFor?: string; error?: string; hint?: string; required?: boolean; children: React.ReactNode })` —— error → `<p role="alert" className="text-xs text-destructive">`。
  - `export function FormFooter({ onCancel, onSubmit, busy, submitDisabled, cancelLabel = "取消", submitLabel = "应用", busyLabel = "应用中" }: { ... })` —— 左 cancel（disabled=busy）、右 submit（disabled=busy||submitDisabled，文案 busy?busyLabel:submitLabel），均 `type="button"`。

- [X] **Step 1: Write the failing tests**（断言：SecretInput type 切换与 reveal 按钮仅非空出现、值变更重置 reveal、onChange trim、aria；FormField error/hint/required/role=alert；FormFooter busy 文案/取消禁用/submitDisabled 联动）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/form/__tests__/form.test.tsx`
Expected: FAIL，模块解析失败

- [X] **Step 3: Implement 三组件**
- [X] **Step 4: Run test to verify it passes**（同命令 PASS，随后全量门禁绿）
- [X] **Step 5: Commit**

```bash
git add src/components/form/
git commit -m "feat(form): DSH 式表单原语 SecretInput/FormField/FormFooter"
```

## Task 2: ChannelForm 按 DSH 模式改造

**Files:**
- Modify: `src/components/ChannelForm.tsx`
- Test: `src/pages/__tests__/`（渠道表单相关既有测试文件，按需更新 + 新增用例）

**Interfaces:**
- Consumes: T1 三组件。
- Produces: 渠道表单行为——主字段：名称/供应商/Base URL/支持模型/API key（SecretInput）；折叠区：upstream_protocol/channel_model_maps/priority/weight/timeout_secs；编辑态 key 留空 → 提交原掩码值（`sk-***` 哨兵原样）；行内错误；校验不过禁用应用；busy 文案。

- [X] **Step 1: Write the failing tests**（新增：折叠区存在且默认收起；必填缺失时应用禁用且行内错误出现；编辑态 key 留空提交 payload 的 api_key 为原掩码值；busy 提交中按钮文案「应用中」；更新既有断言旧布局的用例）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__ -t Channel`
Expected: FAIL（新断言不满足）

- [X] **Step 3: Implement**——重排 ChannelForm（字段划分见设计文档表），接入三组件；保留测试连接按钮与全部既有命令调用。
- [X] **Step 4: Run test to verify it passes**（渠道测试 + 全量门禁）
- [X] **Step 5: Commit**

```bash
git add src/components/ChannelForm.tsx src/pages/__tests__/
git commit -m "feat(form): 渠道表单按 DSH 模式改造"
```

## Task 3: Skills/RoleRoutes 对话框套模式

**Files:**
- Modify: `src/pages/SkillsPage.tsx`、`src/pages/RoleRoutesPage.tsx`
- Test: 各自既有测试文件更新

**Interfaces:**
- Consumes: T1 组件。
- Produces: 两个页面的对话框表单 = FormField 行内校验 + FormFooter（应用/应用中/取消）；Skills 的名称/目录/内容必填行内呈现；RoleRoutes 两个编辑对话框同模式；功能不变。

- [X] **Step 1: Write the failing tests**（行内错误渲染 + 应用禁用；替换原 toast-only 断言——Skills 改为 inline-only（删除 handleSave 三处 toast.error 校验，既有测试不断言 toast）；RoleRoutes 保留 toast 兜底不删，仅增行内断言）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__ -t "Skill|Role"`
Expected: FAIL

- [X] **Step 3: Implement**
- [X] **Step 4: Run test to verify it passes**（全量门禁）
- [X] **Step 5: Commit**

```bash
git add src/pages/SkillsPage.tsx src/pages/RoleRoutesPage.tsx src/pages/__tests__/
git commit -m "feat(form): Skills 与角色路由对话框套用 DSH 表单模式"
```

## Task 4: McpServers/定价段/密钥创建卡套模式

**Files:**
- Modify: `src/pages/McpServersPage.tsx`、`src/pages/SettingsPage.tsx`（模型定价段）、`src/pages/ApiKeysPage.tsx`
- Test: 各自既有测试文件更新

**Interfaces:**
- Consumes: T1 组件。
- Produces: MCP 表单套模式（高级项入折叠区，按现有字段定）；模型定价段与密钥创建卡（名称+配额，无 key 输入）套 FormField/FormFooter 行内校验；功能与命令不变。

- [X] **Step 1: Write the failing tests**（各一处行内错误/禁用断言）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pages/__tests__`
Expected: FAIL（新断言）

- [X] **Step 3: Implement**
- [X] **Step 4: Run test to verify it passes**（全量门禁）
- [X] **Step 5: Commit**

```bash
git add src/pages/McpServersPage.tsx src/pages/SettingsPage.tsx src/pages/ApiKeysPage.tsx src/pages/__tests__/
git commit -m "feat(form): MCP/定价/密钥表单套用 DSH 表单模式"
```

## Task 5: minor 批次 A（组件替换与事件常量）

**Files:**
- Modify: `src/pages/McpServersPage.tsx`（状态点→StatusBadge）、`src/components/Layout.tsx`、`src/pages/DashboardPage.tsx`、`src/pages/LogsPage.tsx`、`src/pages/SettingsPage.tsx`（gateway-refresh 常量 + 重启广播）、`src/lib/tagStyles.ts`（新建）、`src/pages/ChannelsPage.tsx`、`src/pages/SessionsPage.tsx`（NEUTRAL_TAG 共享）、`src/pages/LogsPage.tsx`（seq tabular-nums）
- Create: `src/lib/events.ts`、`src/lib/tagStyles.ts`
- Test: 相关既有测试文件更新

**Interfaces:**
- Produces:
  - `export const GATEWAY_REFRESH_EVENT = "gateway-refresh"`（src/lib/events.ts；Layout 监听 + Dashboard/Logs/Settings 四处引用统一，Settings `restartGateway` 成功后 dispatch）。
  - `export const NEUTRAL_TAG = "inline-flex items-center rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-xs text-muted-foreground"`（src/lib/tagStyles.ts；Channels/Sessions 引用）。
  - McpServers 状态点 → StatusBadge（success/neutral）。
  - LogsPage seq 列 `tabular-nums`。

- [X] **Step 1: Write the failing tests**（grep 守卫：`src/**/*.tsx` 中不再出现字符串 "gateway-refresh"（events.ts 除外）与重复 NEUTRAL_TAG 字面量——可用 ?raw glob 模式，参照 tokens-guard；MCP 状态徽章类断言）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tokens-guard.test.ts src/pages/__tests__ -t "gateway|NEUTRAL|MCP"`
Expected: FAIL

- [X] **Step 3: Implement** 按 Produces 全部落地。
- [X] **Step 4: Run test to verify it passes**（全量门禁）
- [X] **Step 5: Commit**

```bash
git add src/lib/events.ts src/lib/tagStyles.ts src/components/Layout.tsx src/pages/
git commit -m "refactor(ui): 遗留 minor 清理批次 A"
```

## Task 6: minor 批次 B（焦点环/主题同步/capabilities）

**Files:**
- Create: `src/lib/focusRing.ts`（`export const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-0"`)
- Modify: `src/pages/` 各裸 button 链接处、可点击表格行、`src/lib/theme.ts`（useTheme 跨源同步）、`src-tauri/capabilities/default.json`
- Test: theme.test.ts 追加同步用例；focus ring grep 守卫并入 tokens-guard 或独立

**Interfaces:**
- Produces:
  - `FOCUS_RING` 常量应用于全部裸 button 链接（编辑/删除/导入/同步等）与可点击表格行（行加 `tabIndex={0}` + Enter/Space 激活走既有 onClick——行激活仅限确有 onClick 的行）。
  - useTheme：theme.ts 镜像解析完成/主题变更时通知订阅者，`mode` 状态对齐（`ensureThemeReady` 后回调）。
  - capabilities：`store:default` → `["store:allow-load","store:allow-get","store:allow-set","store:allow-save"]`（以 ACL manifest 实际标识为准；theme 持久化测试必须保持绿）。

- [X] **Step 1: Write the failing tests**（theme 跨源同步用例：ensureThemeReady 后 useTheme 的 mode 更新；focus ring grep 守卫：裸 button className 含 FOCUS_RING 导入——以源码 grep 断言 `text-primary hover:underline` 类裸按钮均伴随 focus ring）
- [X] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/theme.test.ts src/tokens-guard.test.ts`
Expected: FAIL

- [X] **Step 3: Implement**
- [X] **Step 4: Run test to verify it passes**（全量门禁）
- [X] **Step 5: Commit**

```bash
git add src/lib/focusRing.ts src/lib/theme.ts src/lib/__tests__/theme.test.ts src/pages/ src/tokens-guard.test.ts src-tauri/capabilities/default.json
git commit -m "refactor(ui): 遗留 minor 清理批次 B"
```

## Task 7: 全量验证

**Files:**
- Create: `docs/changes/2026-10-18-dsh-style-form-dialogs-and-minor-sweep/build-notes.md`（裁决与偏差记录）

- [X] **Step 1: 全量门禁**：`pnpm typecheck && pnpm test:unit` 全绿；`git diff src-tauri/` 仅 capabilities JSON。
- [X] **Step 2: 遗留 minor 核销清单**：对照上一 change 报告的 9 项逐项标注落点（build-notes.md）；warning 令牌观感项标注"留用户目检"。
- [X] **Step 3: Commit**

```bash
git add docs/changes/2026-10-18-dsh-style-form-dialogs-and-minor-sweep/build-notes.md
git commit -m "docs(ui): DSH 表单改造验证记录与 minor 核销清单"
```
