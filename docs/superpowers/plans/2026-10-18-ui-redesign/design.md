# design · UI 重设计（2026-10-18）

依据：`docs/superpowers/specs/2026-10-18-ui-redesign-design.md`。

## 模块与文件清单

| 模块 | 文件 | 动作 |
|---|---|---|
| 令牌层 | `src/index.css` | 重写：`:root` 浅色 + `.dark` 暗色两组 HSL 变量（新增 success/warning/info/faint/surface），`--font-mono`；保留 usage-range 容器查询 |
| 令牌映射 | `tailwind.config.cjs` | 增加 success/warning/info/faint/surface 色组、fontFamily.mono |
| 主题逻辑 | `src/lib/theme.ts`（新建） | 三态解析/应用/监听/持久化 |
| 主题持久化 | `package.json`、`src-tauri/capabilities/*.json`（新增） | 加 `@tauri-apps/plugin-store` + 权限；不可行则降级 `localStorage`（`lib/theme.ts` 内部封装，接口不变） |
| 共享组件 | `src/components/StatusBadge.tsx`、`StatCard.tsx`、`SegmentedTabs.tsx`（均新建） | 见接口契约 |
| 布局 | `src/components/Layout.tsx` | 重写：分组侧边栏 + 顶栏状态 + 限宽 |
| 页面 | `src/pages/{Dashboard,Logs,Channels,Settings}.tsx` | 重构；`ApiKeys/RoleRoutes/Security/Knowledge/Prompts/Skills/McpServers/Records` 扫改 |
| 图表 | `src/components/LogTrendChart.tsx` | 系列色改从 CSS 变量取（`getComputedStyle` 或透传色值映射表） |

## 数据模型：令牌表

直接采用设计文档定稿表（暗色 `#0C1216/#0A0F12/#0E161A/#16242A/#C7DCDF/#7D949A/#4D666D/#3ECFBB/#57C98B/#E0B05E/#E07A6B/#6FB7E8`）。实现按仓库现状用 HSL 三元组（现有 `--primary: 210 100% 56%` 风格），一处定义。

- `--accent` 保持中性灰（= 现 muted 系），不指向青碧。
- `--primary` = 青碧；`--ring` = 青碧。

## 接口契约

```ts
// src/lib/theme.ts
export type ThemeMode = "light" | "dark" | "system";
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark";
export function applyTheme(mode: ThemeMode): void;          // 挂/摘 <html>.dark
export function useTheme(): { mode: ThemeMode; setMode: (m: ThemeMode) => void };
// 持久化：优先 tauri-plugin-store（key "theme"），不可行降级 localStorage；实现隐藏在模块内。

// src/components/StatusBadge.tsx
type Semantic = "success" | "warning" | "danger" | "info" | "neutral";
export function StatusBadge({ semantic, children, className }: ...);
export function httpStatusSemantic(code: number): Semantic;  // 2xx→success, 429→warning, 其他4xx/5xx→danger
export function riskSemantic(level: string): Semantic;       // clean→neutral, info→info, low→success,
                                                             // medium→warning, high/critical→danger

// src/components/StatCard.tsx
export function StatCard({ label, value, hint?, progress? }: {
  label: string; value: string; hint?: string; progress?: number; /* 0-100 */
});

// src/components/SegmentedTabs.tsx
export function SegmentedTabs<T extends string>({ value, onChange, options }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] });
```

- `riskSemantic` 的映射放独立导出，供 `LogTrendChart` 系列色复用（风险 6 级图表色 = danger 两档明度用透明度/色阶变量实现）。

## 图表取色

`LogTrendChart` 现用硬编码色。改法：组件内定义 `seriesColor(dim, seriesKey): string`，值来自 CSS 变量（`var(--primary)` 等经 `getComputedStyle(document.documentElement).getPropertyValue` 读取，recharts 接受任意 CSS 色）；主题切换时组件随重渲染重新读取（依赖 theme state 或监听 class 变化）。

## 顶栏状态映射

```ts
// Layout 内联或 lib/gatewayStatus.ts
export function gatewayStatus(boundAddr?: string | null): { semantic: "success" | "danger"; label: string };
// bound_addr 非空 → success/"网关运行中"；空/null/undefined → danger/"未运行"
```

数据源：`api.getAppConfig().bound_addr`（现有命令），调用点在 Layout 挂载时 + 自定义事件（页面 10s 刷新时 dispatch `window.dispatchEvent(new CustomEvent("gateway-refresh"))`，Layout 监听后重新拉取——避免独立轮询）。

## TDD 测试策略（严格先测后码）

| 模块 | 先写的失败测试 | 验证命令 |
|---|---|---|
| `lib/theme.ts` | `src/lib/__tests__/theme.test.ts`：resolveTheme 三态×系统偏好矩阵；applyTheme 挂/摘 class；setMode 触发持久化 | `pnpm vitest run src/lib/__tests__/theme.test.ts` |
| `StatusBadge` | `src/components/__tests__/StatusBadge.test.tsx`：五变体 class；httpStatusSemantic/riskSemantic 映射矩阵 | `pnpm vitest run src/components/__tests__/StatusBadge.test.tsx` |
| `StatCard` | `src/components/__tests__/StatCard.test.tsx`：label/value/hint/progress 渲染；tabular-nums 类存在 | 同上文件级 |
| `SegmentedTabs` | `src/components/__tests__/SegmentedTabs.test.tsx`：受控切换回调、aria、键盘方向键 | 同上文件级 |
| `Layout` 顶栏 | `src/components/__tests__/Layout.test.tsx`：bound_addr→状态色/文案；8 入口分组齐全 | 同上文件级 |
| 令牌收敛 | `src/tokens.test.ts`（或 scripts 检查）：grep 断言 `src/**/*.tsx` 无硬编码调色板色类 | `pnpm test:unit` |
| 页面重构 | 既有 `src/pages/__tests__/*` 全程保持绿（重构属行为不变改造，测试先行=确认现有测试在改动前通过，改动后仍通过；新增行为才先写失败测试） | `pnpm typecheck && pnpm test:unit` |

- 纯样式重构（表格行高、间距、删除渐变条）无新行为，不造伪测试；其"验证"= 上述既有测试 + typecheck + 人工两态目检。
- 每个任务流程：写失败测试 → 跑红 → 实现 → 跑绿 → `pnpm typecheck && pnpm test:unit` → **原子 commit**（显式 `git add` 本任务文件；不 push；不带入无关既有改动）。

## 风险与决策记录

- plugin-store 前端授权不可行 → localStorage 降级（接口不变），记录在实现说明。
- `sp` CLI 缺失 → 三产物落 `docs/superpowers/plans/2026-10-18-ui-redesign/`，跳过 sp 子 issue 生成。
- 现有页面测试若断言了将被替换的类名/结构，按新组件语义同步更新断言（属测试修正，不算掩盖回归）。
