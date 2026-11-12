# 第三轮进度

计划：本会话 `harmonic-discovering-gadget.md`（第三轮，已批准）。

- [x] 渠道模型接口及新建弹窗
- [x] 结构化会话解析与阅读器
- [x] 架构对比
- [x] 全量测试与浏览器验收
- [ ] 提交、合入 master、推送并核对远端

约束：保留前两轮改动；cc-switch 只读；不使用代理/worktree；测试不操作真实凭据、会话或 CLI 配置；不强推。
Pre-flight：会话解析新增可选 blocks，由前端类型与 reader 消费；旧 content/role/ts 保留。模型列表 API 签名不变，改变空/错结果的可见语义。
Ruling: 新增安全 Markdown 与虚拟列表依赖，详情惰性加载 — 参考 cc-switch 交互，独立实现而非复制其私有组件树 — 依赖和 lockfile 必须一并验证。

## 证据与决策
- 渠道模型前端 4 个新回归均先红后绿；后端 Anthropic 真请求/分页与错误结构测试先红（空返回、未识别错误结构），后绿，渠道组 24 项通过。
- 三 provider 结构化消息测试先红（blocks 缺失），后绿；session_manager 41 项通过，保留路径/删除安全测试。
- 阅读模型与交互 8 项通过；覆盖工具配对、混合 user 记录、孤立结果、折叠搜索、Markdown/远程图片/危险链接与复制。
- 全量前端旧测试因超时 label 改名、工具过程折叠及惰性模块冷加载需要迁移：保留原 payload/竞态断言，按真实 UI 展开工具；在测试收集阶段预加载 chunk，避免用加载依赖的耗时污染 5 秒交互计时。438 项已全绿。
- Ruling: 不关闭占用 8779 的用户网关；修正既有 restart_failure 测试硬编码默认端口的假设 — 首次全量 475/476，失败在已有进程占端口；测试从可用端口开始，阻塞其后的候选，仍验证重启失败与旧地址恢复 — 改动仅测试，不改生产重启逻辑。修后 cargo test 全量通过。
- Ruling: Pencil 额度用尽，XaYZP 设计稿最小同步暂不执行 — 不绕过服务限制、不直接读写 .pen — 代码与设计稿暂有已明确记录的阅读器差异。
- Ruling: 原 5173 两个 Vite 共享旧依赖缓存，新依赖请求挂起；用独立 5176 renderer/cache 和 5177 只读代理验收，不终止用户既有服务 — 验证当前源码而不覆盖用户进程；首次独立启动遗漏项目 cwd 导致 Tailwind 配置查找失败，修正启动目录后正常。
- 架构比较额外核实：生产 forwarder 目前固定 seed=1，不能承诺比例分流；cc-switch 显式 Stack 请求与默认无前缀请求的路由状态处理有区别。只记录现状，不改调度语义。
- Final review: self-review（遵守不使用代理的约束），没有独立第二位审查者。
- Final: fixed Codex response object id 与 call_id 混淆 — 同时携带两种 ID 的真实结构夹具 RED→GREEN。
- Final: fixed Gemini key 中 & 破坏 query — localhost HTTP 夹具 RED→GREEN，验证分页 token 中 + 亦正确保留。
- Final: fixed 中途助手说明误作最终回复 — 最后一条仍为工具结果的阅读模型测试 RED→GREEN。
- Final: fixed 窄屏虚拟列表无高度上界 — 浏览器首轮 768/390px 失败，固定阅读器高度后 64 组全通过；220 轮 / 880 条消息仍只渲染可见行，搜索可跳至最后一轮。
- Final: fixed 手机选择详情仍停在列表及惰性加载后高度变化 — 两层定位行为测试先红后绿；窄屏阅读器截图与交互重验。
- 后端最终：cargo test 17 个测试进程、547 项通过（478 unit + 69 integration）；cargo fmt --check 通过。
- Deferred minor: 主入口 chunk >500 kB 的既有构建警告继续保留，阅读器已单独分包，不借本轮扩大分包重构。
