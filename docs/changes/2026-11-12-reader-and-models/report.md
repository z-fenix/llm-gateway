# 第三轮：渠道模型、会话阅读器与架构比较

日期：2026-11-12～2026-11-13。仓库：`llm-gateway`；参考仓库 `cc-switch@d300a120` 保持只读。

## 实现

### 新建渠道
- 对照 `oRQ5L/qAs3W`：672px 模态、桌面 28px padding、23px 标题；名称/供应商等分，协议 220px、地址自适应；模型配置→模型名称映射入口→优先级/权重/超时；正文内部滚动，固定操作区。
- 供应商使用友好名称；新建态联动协议，编辑态不覆盖既有协议。凭据仍 write-only，掩码哨兵由后端按 channel ID 恢复，不把静态示例写入业务值。
- 上游成功只显示真实返回的候选；空结果明确说明；失败在表单内显示可操作原因，静态参考与上游结果不混淆。输入地址/协议/凭据变化会作废旧请求，仍可手动输入模型。
- 后端去掉 Anthropic 直接空返回，实际请求 `/v1/models`，携带 `x-api-key` / `anthropic-version: 2023-06-01`；支持 Anthropic 与 Gemini 分页、游标去重、100 页上限和整体超时。缺少正确数组/ID 的 JSON 不再静默变成空成功。错误不回显响应体或带凭据 URL。
- Gemini query key 和 page token 使用 URL 编码，避免 `&` / `+` 损坏鉴权或分页。

### 会话详情
- 保留本地 CLI 来源、真实标题/路径/时间、列表筛选/删除确认、关联请求日志与异步竞态保护。
- 按“提问—执行过程—最终回复”组织；过程与每一步分别可展开，工具输入/结果及失败状态可读，未给出的名称或状态不伪造。
- 正文搜索覆盖折叠工具参数/输出，自动展开并定位；上一处/下一处、轮次目录、对话/工具筛选、复制消息/会话/真实恢复命令、跳到底部。
- Markdown 支持列表/表格/代码块与复制；无 raw HTML，危险链接不创建，图片不自动加载；超 64 KiB 正文退化纯文本。只复制恢复命令，不执行命令。
- 新增可选 `blocks`，保留原 `role/content/ts` 兼容字段；Claude、Codex、Gemini 保留真实工具和思考信息。Codex 关联使用 `call_id`，不能误用 response object 的 `id`。
- 阅读器惰性分包，长会话虚拟化。窄屏固定阅读区高度，避免虚拟总高度撑开容器；工具长输出局部滚动。手机选中会话先定位详情，惰性阅读区挂载后再校正位置，避免详情留在列表下方。

### 架构比较

完整分析：[角色路由与 cc-switch Stack](../../architecture/role-routing-vs-cc-switch-stack.md)。

**角色模式是服务端策略抽象，Stack 是客户端显式供应商/模型身份选择。** 角色模式可多候选、熔断和回退；Stack 显式目标单家直达、无静默换家，错误编码 ID 不回落默认。后者不是多模型投票/并发聚合，也不是自动容灾池。

比较还区分了默认无前缀请求与显式 Stack 请求的路由统计，并记录本项目当前固定 seed 的确定排列限制。本轮不改生产调度算法，不引入 Stack 模式。

## 验证记录

最终机器结果及截图验收见 [verification.json](verification.json)、[acceptance.json](acceptance.json) 与 `screenshots/`。

| 验证 | 最终结果 |
| --- | --- |
| 前端全量 | 43 个文件，441 项测试通过 |
| 后端全量 | 17 个测试进程，547 项通过（478 unit + 69 integration） |
| 类型与构建 | typecheck、renderer build 通过 |
| Rust 格式与 Git 空白 | cargo fmt --check、git diff --check 通过 |
| 浏览器矩阵 | 64 组通过；运行时异常与页面/主内容/弹窗横向溢出为 0 |
| 长会话 | 220 轮、880 条消息；虚拟化及搜索最后一轮通过，窄屏正文限高 |
| 构建体积 | 主包 968.67 kB / gzip 291.30 kB；独立 reader 216.96 kB / gzip 66.83 kB |

单元测试仍有既有 React `act` / controlled-state 夹具警告；输出不是零警告。真实浏览器矩阵无捕获的运行时异常。模式扫描未发现新增凭据形态串，不将其描述成全面安全审计。

代表性截图：[新建渠道](screenshots/create-success-light-1440.png) · [桌面阅读器](screenshots/reader-light-1440.png) · [手机深色阅读器](screenshots/reader-dark-390.png) · [矮窗内部滚动](screenshots/short-dialog-dark-390.png)。已实际查看代表性图片，包含补定位后的窄屏详情，而非只检查 DOM。

回归过程保留：
- 模型空/错误/候选/竞态 4 项、后端 Anthropic 请求/响应结构、三 provider metadata 都先复现失败再修复。
- 首次完整 Rust 测试 475/476，通过以外的一项是 `restart_failure_returns_err_and_restores_old_gateway` 硬编码 8779，但用户网关已占用该端口。未终止用户网关；仅修测试端口选择/占位方式，仍验证失败恢复逻辑。后续全量结果见机器摘要。
- 旧前端断言迁移到新超时 label、显式展开的工具内容；冷加载 chunk 在测试收集阶段预加载，保留请求 payload 与切换竞态断言。
- 浏览器首轮 64 场景中，窄屏长会话因容器无高度上界而失去有效虚拟化，已通过明确阅读区高度修复；初次证据保留 `acceptance-initial.json`。后续并发编译时出现 CDP 超时，改为串行完成浏览器与最终测试，不用增大产品延迟或降低断言回避。
- 自审复现并修复：Codex object ID 与 call ID 混淆；Gemini 特殊字符 key 编码；最后事件仍为工具结果时，不把中途助手说明标作最终回复。

## 验收边界与未完成项

- 原生后端通过 localhost mock HTTP 测试真实模型请求链路；GUI 通过只读合成 bridge 验证。**未调用真实上游凭据，不声称原生 Tauri 与真实供应商完整端到端已验证。**
- 原有 8779 网关、5173 renderer 和普通浏览器未被停止。验收使用独立 renderer/cache `5176` 与只读预览 `5177`，Chrome 为专用隔离 profile。
- **Pencil 额度已用尽，XaYZP 阅读器设计稿最小同步未执行。** 未通过文件系统绕过 MCP 限制修改 `.pen`；实现以本轮批准的 cc-switch 阅读交互为准。
- 前端构建仍有原主包超过 500 kB 的警告；阅读器已独立分包。本项目无 ESLint 配置，不声称 lint 通过。
- 作者自审，没有独立第二位代码审查者；cc-switch 未修改、未复制其私有阅读组件树。

## 复验

```bash
# renderer 可用时：只读代理（默认端口 5174，可覆盖）
PREVIEW_PORT=5177 RENDERER_PORT=5176 node scripts/design-preview.mjs
# 专用 Chrome CDP 9226，Node 24
node scripts/design-parity-round3.mjs
RETRY_ONLY=1 node scripts/design-parity-round3.mjs
pnpm test:unit
pnpm typecheck
pnpm build:renderer
# 在 src-tauri 下
cargo fmt --check
cargo test
```

资料：[Anthropic Models List 官方文档](https://platform.claude.com/docs/en/api/models/list)。当前修复使用稳定版本头，未将搜索摘要中的未来版本号硬编码到请求。
