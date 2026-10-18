# specs · UI 重设计（2026-10-18）

依据：`docs/superpowers/specs/2026-10-18-ui-redesign-design.md`（已定稿并通过）。

每条需求 = 可验证条目，R 编号；验收标准以 **AC** 标注。

## R1 设计令牌层（含暗色）

- **R1.1** `index.css` 定义 `:root`（浅色）与 `.dark`（暗色）两组令牌：background/surface/card/border/foreground/muted-foreground/faint/primary/success/warning/danger/info，暗色值按设计文档定稿表。
- **R1.2** `tailwind.config.cjs` 扩展映射：`success/warning/info/faint/surface` 色组与 `font-mono` 字体族。
- **AC**: 全项目（`src/` 下 tsx）不再出现硬编码调色板色类（`grep -rE "(text|bg|border)-(red|green|emerald|amber|orange|purple|violet|blue|sky|cyan|slate|teal|rose|yellow)-[0-9]"` 结果为 0，`ui/` 原语内部默认样式除外）；暗色模式下卡片 `#0E161A`、正文 `#C7DCDF`。
- **R1.3** 主题状态模块 `lib/theme.ts`：三态（light/dark/system，默认 system），应用到 `<html>` class，监听 `prefers-color-scheme` 变化。
- **AC**（TDD）: 单测覆盖三态解析（system+系统偏好 → 实际 class）、切换、监听注销。

## R2 主题持久化与设置外观分组

- **R2.1** 前端补装 `@tauri-apps/plugin-store`，capabilities 授权读写 `store.bin`；主题选择持久化。若 capability 授权不可行，降级 localStorage（实现说明中记录）。
- **AC**: 重启应用后主题选择保留；Rust 代码零改动（`git diff src-tauri/` 为空）。
- **R2.2** 设置页新增「外观」分组置顶：浅色/深色/跟随系统 三态分段控件。
- **AC**: 点击即生效（无需保存按钮），重启后保留。

## R3 共享组件

- **R3.1** `StatusBadge`：success/warning/danger/info/neutral 五语义变体；收编 LogsPage `riskBadgeClass`、ChannelsPage 渠道/供应商徽章、HTTP 状态码徽章。
- **AC**（TDD）: 组件单测（变体→class 映射）；页面渲染测试中风险/状态徽章类名来自组件。
- **R3.2** `StatCard`：label + 等宽大数字（tabular-nums）+ 可选进度条/副注；替换 Dashboard 与 Logs 的全部复制写法（≥12 处）。
- **AC**（TDD）: 组件单测；两页不再存在 `text-2xl font-bold` 统计卡裸写法。
- **R3.3** `SegmentedTabs`：左侧竖条 + tint 底单一实现；替换仪表盘/日志维度 tabs 与渠道状态筛选三处实现。
- **AC**（TDD）: 组件单测（受控 value/onChange、键盘可达）；三处调用点替换完成。

## R4 布局骨架

- **R4.1** 侧边栏分组：运行（概览/日志与会话）、配置（渠道/密钥/角色路由）、能力（安全审计/资源）、系统（设置沉底，分隔线）；入口与路由不变。
- **AC**: 8 个入口齐全、路由不变；选中态 = 左侧 2px primary 竖条 + tint 底。
- **R4.2** 顶栏：`lg·gateway` 字标 + 网关状态点（`bound_addr` 非空绿/空红，呼吸动画尊重 `prefers-reduced-motion`）+ `:端口`；数据复用 `getAppConfig`，随页面刷新机制更新。
- **AC**（TDD）: bound_addr→状态色映射函数单测；Layout 渲染测试。
- **R4.3** 内容区 `max-width: 1440px` 居中。

## R5 逐页改造

- **R5.1 概览**：StatCard 两行收敛；Logs 的 Top 渠道/Top 密钥移入（趋势图下方）；缓存命中率进度条用 primary；趋势图系列色按设计文档（token 4 系列、风险 6 级语义映射）。
- **R5.2 日志与会话**：统计区压缩为表上单条统计带（总调用/成功率/Token/费用）；表格行高 ~36px、等宽、数字右对齐、状态/风险走 StatusBadge；日志清理区视觉降级；原生 `<select>` 收敛。
- **R5.3 渠道**：删渐变左侧条；启用 = success 状态点 + 中性角色标签；延迟常驻；停用降透明 + 标签；**修复 `hover:border-border-active`**。
- **R5.4 设置**：分组面板式布局；「外观」置顶。
- **R5.5 其余页**（密钥/角色路由/安全/资源/提示词/技能/MCP/记录）：徽章走 StatusBadge、颜色走令牌、PageHeader/空态统一。
- **AC（共用）**: `pnpm typecheck` 与 `pnpm test:unit` 全绿；逐页人工过一遍暗/浅两态。

## R6 提交纪律

- 每个任务完成并验证后**原子 commit**，仅显式 `git add` 该任务文件；不 push；不带入仓库中无关的既有改动。

## 反向验收（全局）

- 主色 `#3ECFBB` 仅出现于 primary 语义（选中态/关键数字/主按钮），`--accent` 保持中性。
- 无新增装饰性渐变；`ui/` 原语源码不改。
