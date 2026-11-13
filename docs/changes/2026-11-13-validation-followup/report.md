# 第四轮：验证与缺陷修复

日期：2026-11-13。基线：`master@79b914f`。工作分支：`fix/reader-model-verification-20261113`。

第四轮验证时保留修改未发布；用户本次明确要求提交、推送主分支并同步 Pencil。实现提交 `fa34523ee6965411306d37980aaa74740edc97ff` 已快进合入 `master`、推送 `origin/master`，并通过 `git ls-remote` 核验一致；本文发布结果随后以纯文档提交补齐，不改已验证的运行时代码。第三轮已发布记录及截图未覆盖；角色调度、数据库、凭据存储格式、参考仓库 cc-switch 均未修改。

## 已复现并修复

| 问题 | 修复与回归证据 |
| --- | --- |
| Gemini 同条消息的工具结果先于调用处理，拆成两个步骤 | 按原始 block 顺序处理非 user 消息；调用与结果按 ID 配对，保留思考和最终正文。`sessionReader.test.ts` 新增同消息组合测试 |
| 同条消息中正文后仍有工具结果，却被标为最终回复 | 使用真实最后事件决定最终回复；新增 call → text → result 回归 |
| 收起过程或虚拟列表卸载后，工具详情展开状态丢失 | 将步骤展开状态提升到阅读器父级；单测验证折叠重开，浏览器验证滚出视口卸载后返回 |
| 工具筛选强制展开、ARIA 显示却为收起；隐藏轮次目录误跳第一行 | 初始进入工具筛选时显式展开，之后允许真实收起；无当前筛选内容的目录按钮禁用 |
| 获取模型期间增删输入行，异步闭包覆盖手填内容或无法补行 | 用最新函数式表单状态保证至少一行，不替换已有模型；新增中途添加并手填、中途删除全部两项回归 |
| 模型菜单已打开时，刷新结果聚焦输入又导致菜单关闭 | 组合框自身输入不再被 Radix 判为应关闭菜单的外部交互，仍保留其他外部点击/键盘行为 |
| 剪贴板拒绝后，代码复制按钮仍显示成功图标 | 复制函数返回成功/失败，图标只依据真实结果；单测和浏览器均模拟拒绝 |
| 模型发现自动跟随重定向 | 专用 `.no_proxy()` / `redirect(Policy::none())` client；localhost 两端点测试复现旧行为访问目标一次，修后不访问目标并明确提示 307 与最终 Base URL。普通网关转发 client 不变 |

原生超大 timeout 测试在当前 Windows 平台修复前已经通过，本轮仅增加边界覆盖，**不把它记作已修复的超时崩溃**。重定向测试使用合成凭据，不声称捕获了真实密钥泄漏。

## 验证

| 验证 | 结果 |
| --- | --- |
| 前端全量 `pnpm test:unit` | 43 文件，449 项通过（比第三轮新增 8 项） |
| 后端全量 `cargo test` | 480 unit + 69 integration = 549 项通过（新增 2 项） |
| `pnpm typecheck`、`pnpm build:renderer` | 通过 |
| `cargo fmt --check` | 通过 |
| 原 64 场景浏览器回归 | 64 项通过；运行时异常、页面/主内容/弹窗横向溢出均为 0 |
| 新增 48 场景组合交互 | 全新串行完整运行 48 项通过；与原矩阵合计 112 项，运行时异常及三类横向溢出均为 0 |
| Git 空白检查与最终自审 | `git diff --check` 通过；作者自审完成，没有独立第二位代码审查者 |

浏览器每组覆盖 1440 / 1024 / 768 / 390 四宽度、浅色/深色主题；矮窗 600px、其余 1000px。长会话为 220 轮 / 880 条合成消息。新增矩阵包含：同消息工具配对、跨折叠及虚拟卸载的展开状态、工具筛选与目录禁用、剪贴板拒绝、延迟模型请求期间添加手填/删除全部。

原生与浏览器证据分开：Rust 用 localhost mock HTTP 走真实命令请求路径；浏览器只在 `__DESIGN_PREVIEW__` 合成 bridge 中延迟/替换测试响应，不对生产 invoke 加后门，不提交创建渠道、不删除会话、不写真实 CLI 配置。

### 证据

- [进度与 RED→GREEN 记录](progress.md)
- [机器验证摘要](verification.json)
- [完整单测/原生/类型/构建日志](logs/)（终端颜色码及尾空白已清理，不改断言和结果）
- [原 64 场景结果](baseline/acceptance.json)
- [组合交互结果](edge/acceptance.json) / [初次结果](edge/acceptance-initial.json)
- 代表截图：[新建渠道](baseline/screenshots/create-success-light-1440.png)、[手机深色阅读器](baseline/screenshots/reader-dark-390.png)、[同消息配对](edge/screenshots/inline-tools-light-1440.png)、[禁用隐藏轮次](edge/screenshots/tools-outline-dark-390.png)、[模型补行](edge/screenshots/models-inflight-delete-light-390.png)、[复制失败](edge/screenshots/clipboard-denied-dark-1440.png)。代表图片已实际打开检查，不仅检查 DOM。

浏览器初次组合矩阵的长会话检查误用了短会话的 `synthetic-needle-0`，而长会话夹具第一轮有意换成超长 `long-output-`。诊断确认工具已正确展开，修正的是测试夹具断言而非业务代码。另一个模型补行焦点检查改为等待实际聚焦，仍断言相同条件，没有降低对焦点的要求。原始失败证据保留，最终补验单独记录。

## 决策与边界

1. 模型发现不自动跟随重定向，仅限制发现请求，保持普通转发不变；依赖重定向的供应商需要填写最终 API 地址，这是兼容性代价。
2. 按既有执行边界进行作者自审，不使用多代理；没有独立第二位审查者的保证。
3. 未使用真实上游凭据，**未验证原生 Tauri + 真实供应商完整端到端**。不把浏览器合成测试描述成真实模型服务成功。
4. 本次通过 Pencil MCP 完成 `Lkmfa / XaYZP` 会话阅读器的增量同步，保留节点身份和 1440×1000 画布尺寸；设计快照与结构检查见 [Pencil 同步记录](pencil/sync.json)。未通过文件系统直接修改 `.pen`。
5. 前端测试仍有既有 React `act`、重复 key / controlled-state 夹具警告；构建保留主包超过 500 kB 警告。不是零警告验收，无 ESLint 配置，不声称 lint 通过。
6. 本轮未主动停止原用户网关、5173 renderer 或普通浏览器。收尾检查 5173 仍监听，但 **8777–8787 均未监听**；未擅自启动或重启真实网关，合成预览通过不代表真实网关当前可用。验收使用隔离 renderer/cache 5176、只读代理 5177、专用 CDP Chrome 9226。
7. 112 场景验收完成后，归档日志触发临时 Vite 的 Windows `EBUSY` watch 错误；只调整临时 renderer 的监听排除规则（docs、Rust target）并重启 5176，阅读器恢复 smoke 通过。未因此修改生产 Vite 配置。验证环境为 Windows，未验证其他操作系统。

## Pencil 同步与发布前复验

- 既有 `XaYZP` 保持身份，增量同步阅读筛选/搜索、轮次过程、一个配对工具的输入/结果/完成状态、最终回复和只读统计；补上会话列表搜索，并使选中会话的消息数量与详情一致。复用现有 HeroUI/语义变量，不重做其他页面。
- [设计快照](pencil/Lkmfa.png) 与 [实际实现展开态](pencil/implementation-reader.png) 已实际查看。原生 `.pen` 位于用户 Pencil 文档目录，设计通过 MCP 修改；仓库保存快照和 [同步记录](pencil/sync.json)，未复制整个文档或组件库。
- `LXn14` 已更新到 `http://127.0.0.1:5177/#/logs?tab=sessions`、1440×1000。Pencil 内嵌 browser 的交互/截图 IPC 请求超时，**未确认其内嵌交互状态**；同地址通过独立 Chrome 完成阅读器/工具展开检查。
- 发布前再次完整运行：449 前端、549 后端、typecheck、renderer build、cargo fmt --check 通过；结果见 `logs/publish-*.log`。原 112 场景结果保留，不将额外 smoke 混计进矩阵。

## 复验命令

在仓库根目录执行前端命令，Rust 命令在 `src-tauri/` 下运行。浏览器矩阵需要独立 renderer 5176、只读代理 5177 与专用 Chrome CDP 9226 已就绪：

```bash
pnpm test:unit
pnpm typecheck
pnpm build:renderer
# src-tauri/
cargo test
cargo fmt --check
# 仓库根目录；单独目录保存本轮证据，不覆盖第三轮
AUDIT_OUTPUT=D:/workplace/project/tools/llm-gateway/docs/changes/2026-11-13-validation-followup/baseline node scripts/design-parity-round3.mjs
node scripts/design-parity-round4.mjs
# 只重跑失败场景，可选 CASE_FILTER 正则；EDGE_AUDIT_OUTPUT 可隔离临时输出
RETRY_ONLY=1 node scripts/design-parity-round4.mjs
```
