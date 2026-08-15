# 阶段 6 · 应用配置 + 导入导出 设计

> 日期:2026-08-15 · 方案 A(Claude Code 全做 + Codex 写配置并补最小 `/v1/responses` 适配)
> 前序:阶段 1-5 已完成(核心网关 / 安全审计 / 日志增强 / 知识库 RAG / MCP Server)

## 1. 目标与非目标

**目标**
1. 固定首选端口 + 把当前网关一键写入 Claude Code / Codex 客户端配置。
2. 全量配置导入导出备份(渠道、API 密钥+配额、角色路由/兜底、安全规则/设置、应用配置),渠道真实 `api_key` 一律脱敏。

**非目标**
- 不改既有表结构/迁移(仅新增代码;复用 store.bin 存应用配置)。
- 不做完整 Responses 流式协议(仅最小适配,见 §5)。
- 不导出渠道真实 `api_key`(脱敏);不支持 Claude Code / Codex 之外的 CLI。
- 不重构成(unsafe)加密备份。

## 2. 关键决策(已与用户确认)

| 决策点 | 结论 |
|---|---|
| CLI 目标 | Claude Code + Codex |
| 导出渠道 `api_key` | **脱敏**(导出不含真实 key,导入后需手动补填) |
| 导出范围 | channels + api_keys(+配额) + role_routes/patterns + fallback + security(设置/内置/自定义规则) + app_config |
| 端口策略 | **固定首选端口**(默认 8779,被占则顺延并 warn,实际 bound 写入 state) |
| 导入冲突 | **导入时询问**(preview 报告冲突数,用户选 skip / overwrite) |

## 3. 模块划分(后端,贴合现有分层)

| 新模块 | 职责 |
|---|---|
| `config/settings.rs` | `AppConfig{ preferred_port }`;store.bin 读写 + `merge_from_store` 纯函数(镜像 `knowledge/settings.rs` 模式) |
| `config/mod.rs` | 导出 `pub mod settings/backup/restore;` |
| `cli_config/mod.rs` | 目标枚举 `CliTarget::{ClaudeCode,Codex}`、`home_dir` 可注入(便于测试)、写文件统一入口 + 备份 |
| `cli_config/claude_code.rs` | 生成/深合并 `~/.claude/settings.json` + `~/.claude.json` 的纯函数 + 落盘 |
| `cli_config/codex.rs` | 生成/合并 `~/.codex/config.toml` 的纯函数 + 落盘;env 写入/说明 |
| `config/backup.rs` | 汇总各表 → 带版本导出 JSON(渠道脱敏) |
| `config/restore.rs` | 解析+校验 + preview(diff 计数) + 按策略落库(全走 repository 参数化) |
| `protocol/responses.rs` | `request_to_chat` / `chat_to_response` + 流式 SSE 合成 |
| `commands/config.rs` | Tauri 命令薄封装(§6) |

**改动既有文件**
- `proxy/state.rs`:`AppState` 增 `bound_addr: Arc<RwLock<Option<SocketAddr>>>`、`app: Arc<RwLock<AppConfig>>`。
- `proxy/server.rs`:router 增 `/v1/responses` 路由;`start` 已返回 `(handle, addr)`,调用方将 addr 写入 `bound_addr`。
- `proxy/handlers.rs`:`Protocol` 枚举增 `Responses`;`handle()`/`handle_stream()` 经 `match proto` 复用整条管线;新增 `responses_messages` handler。
- `lib.rs`:启动时读 `preferred_port` 作为 `start_port`;把 `server::start` 返回的 addr 写入 `bound_addr`;注册新命令。
- `commands/mod.rs`:加 `pub mod config;`。
- 前端:新增 `SettingsPage.tsx`(应用配置页)+ 导航;`lib/api.ts` 加 wrapper;`types/index.ts` 加类型。

## 4. 端口与 bound addr

- `AppConfig.preferred_port: u16`,默认 **8779**(避开常用 8777)。存 store.bin 键 `app.preferred_port`。
- 启动:`start_port = app.preferred_port`(缺省 8779);`server::start` 仍按 `start_port..=8787` 抢占,被占顺延并 `log::warn!`;返回的实际 addr 写入 `state.bound_addr`。
- 改 `preferred_port` **下次启动生效**(命令返回提示「重启后生效」);CLI 写入一律用**当前实际 bound 端口**(从 `bound_addr` 读,None 则报错「网关未启动」)。
- 前端设置页显示:首选端口输入框 + 当前实际 bound 地址(只读)。

## 5. CLI 一键写入

### 5.1 Claude Code
- 目标文件:`~/.claude/settings.json`(用户级)。
- 深合并 `env` 块(保留其它顶层键与 env 内无关键):
  ```json
  { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>", "ANTHROPIC_AUTH_TOKEN": "<sk-lgw-*>" } }
  ```
  (CC 会在 base 后自动拼 `/v1/messages`,正是本网关端点。)
- 同时确保 `~/.claude.json` 置 `hasCompletedOnboarding: true`(否则 CC 1.0.3+ 强制登录页,忽略 env)。深合并保留该文件其它键。
- 写前把已存在文件备份为 `<file>.bak`(已存在 `.bak` 则覆盖)。

### 5.2 Codex
- 目标文件:`~/.codex/config.toml`(用户级;项目级会被忽略,不写)。
- 合并(保留其它键/其它 provider):
  ```toml
  model_provider = "llm-gateway"
  [model_providers.llm-gateway]
  name = "llm-gateway"
  base_url = "http://127.0.0.1:<port>/v1"
  env_key = "LLM_GATEWAY_KEY"
  wire_api = "responses"
  requires_openai_auth = false
  ```
- **密钥不入文件**:经环境变量 `LLM_GATEWAY_KEY` 提供 `<sk-lgw-*>`。命令参数 `write_env: bool`:
  - `true`:写入用户级环境变量(Windows `setx LLM_GATEWAY_KEY <key>`;mac/linux 追加 `export LLM_GATEWAY_KEY=<key>` 到 `~/.profile`,已存在该行则替换)。
  - `false`:不改环境,结果里带 `env_instructions`(对应平台的 export/setx 命令文本)给前端展示。

### 5.3 统一返回
```rust
pub struct CliWriteResult {
    pub path: String,            // 写入的配置文件路径
    pub changed_keys: Vec<String>, // 改动/新增的键(供前端展示)
    pub backup_path: Option<String>,
    pub env_instructions: Option<String>, // codex 且 write_env=false 时给
}
```

## 6. `/v1/responses` 适配(方案 A 核心)

复用 `handle()` 整条管线(鉴权→解析→RAG→安检→角色路由→转发→日志/配额),新增 `Protocol::Responses`,故**安全审计、RAG 注入、配额、请求日志全部自动继承**,不新增绕过路径。

**请求映射 `request_to_chat(&Value) -> Result<ChatRequest,String>`**
- `model` → `chat.model`
- `instructions` → 一条 `system` 消息(置于 messages 首部)
- `input`:字符串 → 单条 `user` 消息;数组 → 逐项取 `type=="message"` 的 `role` + `content[]`(`input_text`/`output_text` 提取文本)映射为 `ChatMessage`
- `max_output_tokens` → `max_tokens`;`temperature` → `temperature`;`stream` → `stream`
- `tools`:仅映射 `type=="function"` 项为 chat tools(name/description/parameters),其余类型忽略(最小适配)
- 其余未知字段并入 `extra` 透传

**响应映射 `chat_to_response(&ChatResponse) -> Value`**(非流式)
```json
{ "id":"resp_…","object":"response","status":"completed","model":"…",
  "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"…"}]}],
  "usage":{"input_tokens":…,"output_tokens":…,"total_tokens":…} }
```

**流式(`stream:true`,Codex 默认)**:内部仍走非流式 `forward`,聚合结果后合成合法 Responses SSE 终态事件序列(整段文本作为单个 delta):
`response.created` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`(带 usage)。

> **风险(如实记录)**:Codex 对 SSE 事件序列挑剔;非流式先行、流式合成需真实 Codex 验证。若流式对不齐,退化为文档注明「Codex 暂用非流式 / 流式后续补」,不阻塞本阶段其余交付。验收含「真实 Codex 连接冒烟」一步。

## 7. 导入导出

### 7.1 导出格式(带版本 JSON)
```json
{
  "format": "llm-gateway-config",
  "version": 1,
  "exported_at": 1723800000,
  "app_config": { "preferred_port": 8779 },
  "channels": [ { "id":"…","name":"…","provider_type":"…","base_url":"…","api_key":"", "models":[],"priority":0,"weight":1,"enabled":true,"timeout_secs":60 } ],
  "api_keys": [ { "id":"…","key":"sk-lgw-…","name":"…","enabled":true,"quota_total":null,"quota_used":0 } ],
  "role_routes": [ {"id":"…","role":"…","channel_id":"…","target_model":"…","enabled":true} ],
  "role_patterns": [ {"id":"…","pattern":"…","role":"…","priority":0,"enabled":true} ],
  "fallback": { "channel_id":"…","model":"…" } ,
  "security": { "settings": {…}, "builtin_rules":[…], "custom_rules":[…] }
}
```
- **渠道 `api_key` 固定导出为 `""`(脱敏)**——安全不变量:导出文件绝不含真实上游 key。
- `api_keys[].key` 为本地 `sk-lgw-*`(用户已选纳入)。**UI 明示**:导出文件含网关访问凭证,需妥善保管。
- `fallback` 为 null 时省略该键。

### 7.2 导出/导入命令
- `export_config(path: String) -> Result<u64,String>`:汇总写文件到 `path`,返回字节数。服务端写文件,前端给默认路径输入框。
- `preview_import(path: String) -> Result<ImportPreview,String>`:解析+校验(format/version),不落库;返回各类型计数 + `conflicts`(与现有同 id 条数)。
  ```rust
  pub struct ImportPreview { pub channels: usize, pub api_keys: usize, pub role_routes: usize,
      pub role_patterns: usize, pub custom_rules: usize, pub conflicts: usize }
  ```
- `import_config(path: String, strategy: String /* "skip"|"overwrite" */) -> Result<ImportResult,String>`:按 id 匹配冲突;`skip` 保留现有,`overwrite` 用导入值覆盖。返回各类 imported/skipped/overwritten 计数。渠道导入后 `api_key` 为空,前端提示需补填。
  ```rust
  pub struct ImportResult { pub imported: usize, pub skipped: usize, pub overwritten: usize }
  ```
- 安全设置/fallback/app_config 导入直接覆盖(单值,无冲突语义)。

### 7.3 冲突交互
前端:选文件 → `preview_import` → 弹窗显示「将新增 X 条,冲突 Y 条」,用户选「跳过已存在 / 覆盖已存在」→ `import_config(strategy)` → 显示结果。

## 8. 数据流

**CLI 写入**:前端选 CLI + 选 API key(+codex 的 write_env)→ `write_cli_config` → 读 `bound_addr` → 生成合并配置 → 备份 → 落盘(+可选写 env)→ 返回 `CliWriteResult` 展示。

**导出**:前端点导出(默认路径)→ `export_config` → 各 repository list 汇总(渠道脱敏)→ 写 JSON 文件 → 提示路径+「含网关凭证」。

**导入**:前端选文件 → `preview_import` → 冲突弹窗 → `import_config(strategy)` → repository 参数化落库 → 结果计数。

**Responses**:`POST /v1/responses` → `handle(Protocol::Responses)` → 与 openai/anthropic 完全同管线 → `responses::chat_to_response`(或流式合成 SSE)。

## 9. 错误处理

- 所有命令返回 `Result<_, String>`(沿用现有命令层风格);生产代码锁一律 parking_lot,无 `.unwrap()`。
- CLI 写入:目标目录不存在则创建;读/解析失败 → 明确错误(带路径);写前必备份。
- `bound_addr` 为 None(网关未起)→ `write_cli_config` 返回「网关未启动」。
- 导入:format/version 不符 → 返回「非 llm-gateway 配置/版本不支持」;单条记录错不阻断整体,计入 skipped 并记 log。
- Responses:请求解析失败 → 400 `invalid_request`;上游错误沿用 `handle()` 现有状态码映射。
- 落库 body 仍经 `redact_json_for_logging`(本阶段不新增 body 写日志路径)。

## 10. 测试策略

- `config/settings.rs`:`merge_from_store` 单测(覆盖默认/缺键/非法值)。
- `cli_config`:纯函数单测——给定既有 `settings.json`/`config.toml` 内容 + base_url/token → 断言深合并保留无关键、目标键正确;`home_dir`/路径注入,temp dir 落盘,断言备份文件生成。
- `config/backup.rs`/`restore.rs`:内存 DB 造数据 → 导出断言**不含渠道真实 key**(grep 断言)→ 全新库导入回环一致;冲突 skip/overwrite 行为各一侧;version 不符报错。
- `protocol/responses.rs`:`request_to_chat`/`chat_to_response` 单测;e2e 起真实网关 POST `/v1/responses`(非流式断言 JSON 结构;流式断言 SSE 事件序列顺序与 usage)。
- 安全回归 grep:`grep -rn "api_key" src-tauri/src/config/backup.rs` 断言仅脱敏赋值;导出文件样本 grep 无真实 key。
- 全量 `cargo test` 不回归,`cargo build` 0 新 warning;前端 `pnpm typecheck`。

## 11. 范围/验收清单

- [ ] 首选端口设置 + 实际 bound 地址展示,重启生效。
- [ ] Claude Code 一键写入(settings.json + .claude.json onboarding),含备份与改动键展示。
- [ ] Codex 一键写入(config.toml + 可选 env 写入/说明),含备份。
- [ ] `/v1/responses` 非流式可用 + 流式合成;真实 Codex 连接冒烟(风险见 §5)。
- [ ] 导出带版本 JSON(渠道脱敏 + 含网关凭证提示)。
- [ ] 导入 preview + skip/overwrite + 结果计数。
- [ ] 安全不变量回归(导出/日志无真实上游 key 泄露)。

## Self-Review 记录

- **Placeholder 扫描**:无 TBD;命令签名、导出格式、CLI 配置形状、SSE 事件序列均给出具体值。
- **内部一致性**:§2 决策(脱敏/skip-overwrite/固定端口/导入询问)与 §5/§7 实现一致;`Protocol::Responses` 复用 `handle()` 与 §6「安全/日志自动继承」一致。
- **范围**:单阶段可实现;Responses 仅最小适配并明确流式风险与降级路径,不越界为完整协议。
- **歧义**:CLI 写入统一用「当前实际 bound 端口」(非 preferred_port)已明确;导入按 id 匹配冲突已明确;Codex 密钥一律经 env 不入文件已明确。
- **遗留风险**:Codex SSE 合成 + env 写入为平台相关高风险点,已在 §5/§6 标注并以「真实 Codex 冒烟」为验收兜底。
