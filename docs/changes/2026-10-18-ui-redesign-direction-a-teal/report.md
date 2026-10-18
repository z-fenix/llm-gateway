# 验证报告 · UI 重设计（方向 A · 青碧信号）

**Change**: `2026-10-18-ui-redesign-direction-a-teal` · **Date**: 2026-10-18 · **Branch**: `feature/ui-redesign-teal` (fdf4269..e8fd830, 15 commits)

## 执行的命令与输出

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（tsc --noEmit 零输出） |
| `pnpm test:unit` | **31 files / 313 tests 全部通过**（含 tokens-guard 三项守卫：调色板色 / dark: / 渐变类） |
| `git diff --stat src-tauri/` | 已跟踪文件零 diff（capabilities/default.json 已随 Task 2 提交；未跟踪 target-test/ 为仓库既有无关产物） |
| `git log master..HEAD` | 15 个原子提交，每任务独立（含 3 个 fix 提交） |

## 逐条需求核对（spec FR/SC）

- **FR-001 令牌统一/无硬编码色** ✅ — tokens-guard 守卫测试常绿；最终审查 grep 复核 0 残留（ui/switch.tsx 例外已在 0b901c7 修为 primary）。
- **FR-002 双主题令牌** ✅ — `:root` 浅色 + `.dark` 暗色；实现取"默认跟随系统"（spec US-2），与"深色为默认观感"的内部张力以前者为准（最终审查记录）。
- **FR-003 三态即时切换** ✅ — Settings 外观分组 + SegmentedTabs，`useTheme.setMode` 即点即生效。
- **FR-004 持久化** ✅ — plugin-store 主通道（capabilities 授权）+ localStorage 降级；`ensureThemeReady` 关闭启动镜像空窗（有竞态测试钉住）。
- **FR-005 数据等宽字体** ✅ — 最终审查发现的缺口（时间戳/base_url）已在 e8fd830 修复；数值列 tabular-nums 右对齐。
- **FR-006 StatusBadge 全覆盖** ✅ — 密钥/KB/安全/技能/熔断/风险/HTTP 全部接入；MCP 自绘状态点记为 deferred minor。
- **FR-007 StatCard/SegmentedTabs 收敛** ✅ — StatCard ×11、SegmentedTabs ×4，无第三种 tabs。
- **FR-008 侧边栏分组** ✅ — 8 入口不变、四组、设置沉底（Layout 测试钉住）。
- **FR-009 顶栏网关状态** ✅ — `gatewayStatus` 映射测试钉住；API 失败降级红点不报错。
- **FR-010 日志表格主体化/Top 榜迁移** ✅ — 统计带 4 项；Top 渠道/密钥在概览（getLogStats 通道，控制器裁决）。
- **FR-011 渠道状态点/弱化/延迟** ✅ — avg=0 不显示延迟的偏差已记录。
- **FR-012 设置分组面板/外观置顶** ✅ — 全部旧 handler/id/aria 经逐条核对保留。
- **FR-013 焦点环/减少动效** ✅ — 控件 focus ring teal；`motion-reduce:animate-none`；裸 button 链接的 ring 记为 deferred minor。
- **FR-014 border-active 修复/dark: 清理** ✅ — 守卫测试钉住 dark: 与渐变类为 0。
- **SC-001~SC-006**：SC-001/002/004/005 由上表证实；SC-003（重启保留）与 SC-006（Tab 遍历）属实机人工验收——`pnpm dev` 由用户确认，属交付后验收项。
- **浅色对比度** ✅ — WCAG 2.x 程序化校验（`docs/changes/.../light-mode-contrast.md`）：success/warning/faint 加深后全部达标（≥4.5 文字、faint ≥3 仅限辅助图形——StatusBadge neutral 已改用 muted-foreground 承载信息文字）。

## 裁决复核（build 期 Ruling 对照 spec）

| Ruling | 复核 |
|---|---|
| 分支内联工作区（不用 worktree，保 mulix 状态） | 成立；未影响产出 |
| Top 榜走 getLogStats 而非 getStats | 成立——spec 只要求"榜单移入概览"，数据源属实现 |
| 图表色 hsl(var(--x)) 包裹 | 成立——HSL 三元组令牌的必然形式 |
| danger→--destructive 别名 | 成立——语义色齐全且被测试钉住 |
| 状态点仅运行态呼吸 | 成立——符合反目标"常驻假状态"精神 |
| ui/switch emerald→primary 一行例外 | 成立——令牌身份优先于豁免字面 |
| spec 内部张力（默认深色 vs 跟随系统） | 以 US-2 为准，已记录 |

## 遗留项（deferred minors，均不阻塞合并）

MCP 自绘状态点、裸 button focus ring、gateway-refresh 魔法字符串 ×4、Settings 重启后不广播刷新、NEUTRAL_TAG 重复、capabilities 最小化、useTheme 跨源同步、StatsPage seq 列 tabular-nums、warning 加深后偏土黄（待目检）。完整清单见 ledger progress.md。

## 结论

**PASS** —— 唯一未自动化验证的是实机目检（pnpm dev 双主题逐页），作为交付后人工验收项，不影响 verify 判定。
