# Build Notes · DSH 式表单弹框交互 + minor 清零

**Change**: `2026-10-18-dsh-style-form-dialogs-and-minor-sweep` · **Branch**: `feature/dsh-form-dialogs` (master..HEAD 提交至 e60b349) · **Date**: 2026-10-19

## 全量门禁输出（Task 7 Step 1）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（`tsc --noEmit` 零输出） |
| `pnpm test:unit` | **32 files / 368 tests 全部通过**（vitest run，exit 0；含 tokens-guard 守卫、form 原语 22 测、theme 27 测、渠道表单 13 测） |
| `git diff master -- src-tauri/` | **仅** `src-tauri/capabilities/default.json` 一处 diff（`store:default` → 四个细粒度 store 权限）；其余 tracked 文件零改动。未跟踪 `src-tauri/target-test/` 为仓库既有无关产物（上一 change 报告已同口径记录） |

运行期 stderr 中的 `act(...)` 警告、recharts `linearGradient` casing 警告与 SessionsPage 重复 key 警告均为存量测试噪音，不影响判定（上一 change 报告已同口径记录）。

## 遗留 minor 核销清单（Task 7 Step 2）

对照上一 change（`2026-10-18-ui-redesign-direction-a-teal`）report.md「遗留项」9 项逐条核销：

| # | 遗留 minor | 落点 | 状态 |
|---|---|---|---|
| 1 | MCP 自绘状态点（未走 StatusBadge） | **T5** `e72e9e4` — `src/pages/McpServersPage.tsx:568` 接入 `StatusBadge`（success/neutral） | ✅ 已核销 |
| 2 | 裸 button focus ring 缺失 | **T6** `b74f4f3` — 新建 `src/lib/focusRing.ts`（`FOCUS_RING` 常量），应用于全部裸 button 链接与可点击表格行；grep 守卫钉住 | ✅ 已核销 |
| 3 | gateway-refresh 魔法字符串 ×4 | **T5** `e72e9e4` — 新建 `src/lib/events.ts`（`GATEWAY_REFRESH_EVENT` 唯一真名），Layout/Dashboard/Logs/Settings 统一引用；grep 守卫钉住 | ✅ 已核销 |
| 4 | Settings 重启后不广播刷新 | **T5** `e72e9e4` — `src/pages/SettingsPage.tsx:271` `restartGateway` 成功后 `dispatchEvent(new CustomEvent(GATEWAY_REFRESH_EVENT))`，顶栏同步网关状态 | ✅ 已核销 |
| 5 | NEUTRAL_TAG 字面量重复 | **T5** `e72e9e4` — 新建 `src/lib/tagStyles.ts`（`NEUTRAL_TAG`），Channels 与 Sessions 共享；grep 守卫钉住 | ✅ 已核销 |
| 6 | capabilities 过宽（`store:default`） | **T6** `b74f4f3` — `src-tauri/capabilities/default.json` 收窄为 `["store:allow-load","store:allow-get","store:allow-set","store:allow-save"]`；theme 持久化测试（27 测）保持全绿 | ✅ 已核销 |
| 7 | useTheme 跨源同步缺位 | **T6** `b74f4f3` — `src/lib/theme.ts` `ensureThemeReady` 在镜像解析完成后 `notifyThemeChange` 重新对齐 `mode`；`theme.test.ts` 追加同步用例钉住 | ✅ 已核销 |
| 8 | seq 列未用 tabular-nums | **T5** `e72e9e4` — `src/pages/LogsPage.tsx:197` seq 列 `font-mono tabular-nums`（上期报告写作 "StatsPage"，实际落点为日志页 seq 列，属上期笔误） | ✅ 已核销 |
| 9 | warning 令牌加深后偏土黄（观感） | **留用户目检** — 令牌值属主观观感裁决，无自动化判据；由用户在 `pnpm dev` 双主题实机目检后决定是否微调 HSL 三元组 | ⏸ 留用户目检 |

核销结论：**9 项中 8 项已在本分支落地并有测试或 grep 守卫钉住；1 项（#9 warning 观感）按裁决留用户目检**，无剩余代码侧遗留。

## 分支提交映射

| Commit | 任务 |
|---|---|
| `fb00723` | T1 共享表单原语 SecretInput/FormField/FormFooter |
| `bed3569` | T2 渠道表单按 DSH 模式改造 |
| `92933da` | T2 fix 渠道表单行内错误按 touched 门控（pristine 不喊错） |
| `e9160bb` | T3 Skills 与角色路由对话框套用 DSH 表单模式 |
| `0f0e11b` | T4 MCP/定价/密钥表单套用 DSH 表单模式 |
| `e72e9e4` | T5 遗留 minor 清理批次 A |
| `b74f4f3` | T6 遗留 minor 清理批次 B |
| `ccc8365` | T6 fix 知识库行键盘激活只认行自身（origin guard） |

## 结论

**PASS** — 全量门禁绿，Rust 侧仅 capabilities JSON 改动（计划授权范围内），上期 9 项遗留 minor 核销完成（8 落地 + 1 留用户目检）。未 push。
