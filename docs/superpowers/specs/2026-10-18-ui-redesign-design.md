# UI 重设计 · 设计文档（2026-10-18，定稿）

## 意图与背景

llm-gateway 是本地 LLM API 网关的 Tauri 桌面端（React + Tailwind + shadcn 风格组件，中文 UI）。现状是 shadcn 出厂默认样式：默认蓝主色、系统字体、复制粘贴的统计卡片、三种互不一致的标签页实现、约 40 处硬编码调色板色。用户每天盯的是模型名、token 数、延迟、成本这类开发者数据，界面却没有为"数据密度"做过设计。

本次改造目标：给应用一个可识别的视觉身份（选定方向：**A · 青碧信号**），补齐真暗色模式，用令牌层收敛颜色失控，用共享组件收敛重复实现，并把网关运行状态放进界面。方向与三张页面视觉稿（日志/渠道/设置）已经用户确认通过（视觉稿存于 `.superpowers/brainstorm/`，暗色稿为准）。

## 目标

1. **视觉身份**：深青灰底 + 青碧色单一强调 + 等宽数据字体，"仪表"气质。
2. **真暗色模式**：`.dark` 令牌 + 浅色/深色/跟随系统三态切换，持久化；同时清理现有 `dark:` 死代码。
3. **令牌层收敛**：语义色（success/warning/danger/info）进 CSS 变量与 Tailwind 配置，替换全部硬编码调色板色。
4. **组件收敛**：StatCard、SegmentedTabs、StatusBadge 三个共享组件，替换三种 tabs 实现与所有复制的统计卡写法。
5. **布局升级**：侧边栏分组、顶栏显示网关运行状态与端口、内容区限宽。
6. **修 bug**：`hover:border-border-active` 引用不存在的颜色（从未生效）。

## 非目标

- 不改任何路由、页面信息架构、后端与 Tauri 命令（例外见"主题持久化"：仅允许改前端依赖与 capabilities 配置）。
- 不更换 UI 框架（保留 Tailwind + 现有 shadcn 组件），不引入新图表库。
- 不做动效系统；仅保留现有 hover/过渡，新增一处状态点呼吸动画。

## 反目标（出现即失败）

- 退回"任何 shadcn 项目都长这样"的默认蓝观感。
- 新增装饰性渐变、阴影堆叠——现 ChannelsPage 的蓝色渐变左侧条要删，不是复制。
- 颜色再次散落各页硬编码。

## 配色令牌（方向 A · 青碧信号，已定稿）

暗色为准绳，浅色由同一系统派生：

| 令牌 | 暗色 | 说明 |
|---|---|---|
| background | `#0C1216` | 应用底 |
| surface（sidebar） | `#0A0F12` | 比 background 深一档 |
| card | `#0E161A` | 卡片/面板 |
| border | `#16242A` | 唯一边框色阶 |
| foreground | `#C7DCDF` | 正文（带青味的浅灰，不用纯白） |
| muted-foreground | `#7D949A` | 次要文字 |
| faint | `#4D666D` | 辅助标签/占位 |
| primary (accent) | `#3ECFBB` | 青碧强调，唯一彩色主张 |
| success | `#57C98B` | 正常/成功/启用 |
| warning | `#E0B05E` | 警告/限流/中风险 |
| danger (destructive) | `#E07A6B` | 错误/删除/高风险 |
| info | `#6FB7E8` | 信息/链接 |

- **主色映射纪律（定稿）**：青碧进 `--primary`；`--accent` 保持中性灰底色（shadcn 原语 ghost/outline hover、select 选项 hover 依赖它，不动 `ui/` 组件源码）。侧栏/分段控件的选中态用 `primary` 的 tint（`bg-primary/10` + 左侧 2px 竖条），不占用 `--accent`。
- 使用纪律：一屏内青碧只出现在"当前态/关键数字/主按钮"，状态色只用于状态。
- 浅色模式：background/card 白、surface 用比白深一档的冷灰（与暗色的"侧栏更深一档"对应）、border 冷灰、foreground 近黑（带青味，约 `#182225` 方向）、primary 用加深青碧（目标正文对比 ≥ 4.5:1，实现时对比度校验定稿）。

## 分类色与图表系列色（定稿）

- **角色徽章 / provider 徽章**：改中性处理——`faint` 底 + 等宽文字，靠文字区分，不再每角色一个颜色。
- **趋势图系列色**：
  - 非语义维度（调用量/成本/缓存）：primary + info + 中性灰阶，不用彩虹。
  - Token 维度 4 系列：input=中性灰、output=primary、cache_read=info、cache_creation=warning。
  - 风险维度 6 级：clean=中性、info=info、low=success、medium=warning、high=danger（80% 明度）、critical=danger（100%）；成功率维度：成功=success、失败=danger。
  - 图表系列色用 CSS 变量取色，全部过对比度校验。

## 字体（定稿）

- UI 字体：`"Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif`（Windows 优先，不打包网络字体）。
- 数据字体（`--font-mono` 令牌）：`"Cascadia Code", Consolas, monospace`，用于：模型名、渠道名/Base URL、API key、token/延迟/成本数值、Session ID、时间戳。
- 所有数值 `font-variant-numeric: tabular-nums`；表格数字列右对齐。

## 布局（定稿）

- 侧边栏（8 个入口不变，加分组）：
  - **运行**：概览、日志与会话
  - **配置**：渠道、密钥、角色路由
  - **能力**：安全审计、资源
  - **系统**：设置（沉底，分隔线隔开）
- 顶栏：左侧 `lg·gateway` 等宽字标；右侧网关状态——状态点（呼吸动画，`prefers-reduced-motion` 时静止）+ `:端口` 等宽字。**状态语义（定稿）**：`bound_addr` 非空 = 绿、为空/绑定失败 = 红；数据复用现有 `getAppConfig`，随各页 10s 自动刷新与手动刷新一并更新，不做独立轮询；纯展示不可点击。
- 内容区：`max-width: 1440px` 居中。

## 共享组件（定稿）

- `StatCard`：label + 等宽大数字 + 可选进度条/副注。
- `SegmentedTabs`：单一实现，形态统一为**左侧竖条 + tint 底**（与侧栏选中态同语言），替换仪表盘/日志/渠道三处各自为政的 tabs。
- `StatusBadge`：语义色映射（success/warning/danger/info/neutral），收编 riskBadgeClass、渠道状态、HTTP 状态码徽章。

## 暗色模式机制（定稿）

- `index.css` 定义 `:root`（浅色）与 `.dark` 两组令牌；`<html>` 挂 class。
- 设置页新增"外观"分组：浅色 / 深色 / 跟随系统（默认跟随系统）。
- **持久化路径（定稿）**：Rust 侧零改动——`tauri-plugin-store` 已在 Rust 侧注册，前端补装 `@tauri-apps/plugin-store` JS 包并在 capabilities 中授权读写 `store.bin`（改的是前端依赖与配置文件，不算改 Rust 代码）。若实现中发现 capability 授权不可行，降级为 localStorage 并在实现说明中记录，不新增 Tauri 命令。
- 跟随系统时监听 `prefers-color-scheme` 变化。
- 现有散落的 `dark:` 工具类全部删除，改为语义令牌。

## 逐页要点（全量范围，已确认）

- **概览**：StatCard 收敛为两行等宽大数字卡；**日志页的 Top 渠道/Top 密钥两榜移入概览**（放趋势图下方）；缓存命中率进度条用 primary；趋势图配色接入上节系列色。
- **日志与会话**：原"6 张统计卡 + 2 张 Top 榜 + 趋势卡"压缩为表格上方一条统计带（总调用/成功率/Token/费用，行内等宽数字）；表格成为主体：行高收紧（~36px）、等宽字体、数字右对齐、状态码与风险走 StatusBadge；日志清理区视觉降级（危险但非常用）；原生化 `<select>` 换 shadcn Select 或统一样式（实现者定其一）。
- **渠道**：删渐变左侧条；启用状态 = success 状态点 + 角色标签（中性处理）；延迟常驻展示（success 色）；停用卡片降透明度 + 停用标签；修复 `border-border-active`。
- **设置**：改分组面板式布局（分组标题 + 行式布局，行左说明右控件）；新增"外观"分组（主题三态）置顶。
- **其余页**（密钥/角色路由/安全/资源/提示词/技能/MCP/记录）：统一 PageHeader 间距、空态样式、按钮层级；徽章全部走 StatusBadge；无结构性改动。

## 留给实现者的

- 日志筛选控件二选一；图表系列色具体校验与微调；浅色各令牌定稿值（过对比度）；主题持久化降级判断。
- 保持 `pnpm typecheck`、`pnpm test:unit` 绿；Rust 侧零改动。
- 提交纪律（用户要求）：**保持原子任务提交**——每个任务（或子任务）完成并验证后单独 commit，只提交该任务的文件；不 push。

## 约束

- Tailwind CSS 变量架构保留（HSL 三元组或直接色值均可，实现者定，但要一处定义处处引用）。
- 中文 UI 文案风格不变（简短、动词开头、不用句号）。
- Windows 是主平台；字体栈必须有 Cascadia/Consolas 兜底。
- 无障碍底线：正文对比 ≥ 4.5:1；键盘焦点环可见（primary 色 ring）；`prefers-reduced-motion` 关闭呼吸动画。
