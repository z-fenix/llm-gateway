# 应用配置、导入导出与 CLI 连接

llm-gateway 启动后默认监听回环地址;本页说明如何查看/修改首选端口、一键写入 Claude Code / Codex 配置、使用 `/v1/responses` 接入 Codex,以及配置导入导出。

## 端口与绑定地址

- **首选端口**:`AppConfig.preferred_port`,默认值 `8779`,有效范围 `8777..=8787`(越界会被钳制回默认值)。
- 修改后保存到 `store.bin` 键 `app.preferred_port`,**下次启动生效**。
- 启动时从 `preferred_port` 开始,按 `start_port..=8787` 依次尝试绑定;若首选端口被占用,自动顺延并 `warn` 日志,实际绑定地址写入 `state.bound_addr`。
- 前端「设置」页显示当前绑定地址(只读),并提供首选端口输入框。CLI 一键写入始终以**当前实际绑定地址**为准;网关未启动时写入命令会失败。

## CLI 一键写入

前端「设置」页选择 CLI 目标、选择本地 API key(`sk-lgw-*`) 后,可一键写入客户端配置。统一返回:

```rust
CliWriteResult {
    path: String,              // 写入的配置文件路径
    changed_keys: Vec<String>, // 改动/新增的键
    backup_path: Option<String>,
    env_instructions: Option<String>,
}
```

### Claude Code

写入两个文件,各产生一个 `CliWriteResult`:

1. `~/.claude/settings.json`
   - 深合并 `env` 块,保留其它顶层键与 `env` 内无关键:
   ```json
   { "env": {
       "ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>",
       "ANTHROPIC_AUTH_TOKEN": "<sk-lgw-*>"
   }}
   ```
   - `ANTHROPIC_BASE_URL` **不带 `/v1`**;Claude Code 会自行拼接 `/v1/messages`。
2. `~/.claude.json`
   - 深合并确保 `hasCompletedOnboarding: true`,否则 CC 1.0.3+ 会强制登录页并忽略 env。

两个文件写入前若已存在,会备份为 `<文件名>.bak`。

### Codex

写入 `~/.codex/config.toml`:

```toml
model_provider = "llm-gateway"
[model_providers.llm-gateway]
name = "llm-gateway"
base_url = "http://127.0.0.1:<port>/v1"
env_key = "LLM_GATEWAY_KEY"
wire_api = "responses"
requires_openai_auth = false
```

- **密钥不写入文件**:通过环境变量 `LLM_GATEWAY_KEY=<sk-lgw-*>` 提供。
- `write_env` 参数:
  - `true`:自动写入用户级环境变量。Windows 执行 `setx LLM_GATEWAY_KEY <key>`;macOS/Linux 追加/替换 `export LLM_GATEWAY_KEY=<key>` 到 `~/.profile`。
  - `false`:不修改环境,在 `env_instructions` 中返回对应平台的 export/setx 命令文本,用户需手动执行并重启终端/Codex。

## `/v1/responses` 适配

Codex `wire_api="responses"` 会调用网关 `POST /v1/responses`。该路由复用统一管线:

```
鉴权 → 解析为 ChatRequest → RAG 注入 → 请求安检 → 角色路由 → 上游转发 → 响应安检/日志/配额
```

因此安全审计、RAG、配额、请求日志全部自动继承,没有绕过路径。

请求映射(最小适配):

- `model` → `chat.model`
- `instructions` → 一条 `system` 消息,置于 messages 首部
- `input`:
  - 字符串 → 单条 `user` 消息
  - 数组 → 逐项取 `type=="message"` 或含 `role` 的项,`content[]` 提取文本,映射为 `ChatMessage`
- `max_output_tokens` → `max_tokens`
- `temperature` → `temperature`
- `stream` → `stream`
- `tools` 中仅 `type=="function"` 项被映射为 chat tools,其它类型忽略

响应:

- **非流式**(`stream:false`):返回 Responses 响应壳,`status="completed"`,output 包含 `output_text` 文本与 usage。
- **流式**(`stream:true`):网关内部仍按非流式转发,拿到完整结果后**合成终态 SSE 事件序列**: `response.created` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`(整段文本作为单个 delta) → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`(带 usage)。

> 注意:流式实现为最小合成适配,并非真实上游流式响应。若真实 Codex 在流式模式下出现协议对不齐,可先用非流式,或后续针对 Responses 流式协议做更细粒度实现。

## 导入导出

### 导出格式

导出为带版本 JSON:

```json
{
  "format": "llm-gateway-config",
  "version": 1,
  "exported_at": 1723800000,
  "app_config": { "preferred_port": 8779 },
  "channels": [ { "id":"...", "api_key":"", ... } ],
  "api_keys": [ { "id":"...", "key":"sk-lgw-...", ... } ],
  "role_routes": [ ... ],
  "role_patterns": [ ... ],
  "fallback": { "channel_id":"...", "model":"..." },
  "security": { "settings": {...}, "builtin_rules": [...], "custom_rules": [...] }
}
```

- **渠道真实 `api_key` 一律脱敏为 `""`**;导出文件**不含上游渠道密钥**。
- `api_keys[].key` 为本地 `sk-lgw-*` 网关凭证,因此导出文件**包含网关访问凭证**,请妥善保管。前端导出区有明示提示。

### 导入流程

1. `preview_import(path)` 解析文件,校验 `format` 与 `version`,返回各类计数与冲突数,**不落库**。
2. 用户选择 `skip`(保留现有)或 `overwrite`(覆盖现有)。
3. `import_config(path, strategy)` 按策略落库,返回 `imported`/`skipped`/`overwritten` 计数。

冲突判定:

- `channels` / `api_keys` / `role_patterns` / `custom_rules`:按 `id` 匹配。
- `role_routes`:按 `role` 匹配。

导入后,渠道的 `api_key` 为空,需要到「渠道」页补填真实上游密钥方可使用。

## 冒烟验证

> 以下步骤需人工在真实 GUI/CLI 中执行,当前文档只记录验证流程,不自动启动客户端。

1. 启动 llm-gateway 应用,进入「API 密钥」页,确认已有 `sk-lgw-*` 密钥(没有则创建)。
2. 进入「设置」页:
   - 确认「当前绑定地址」显示 `http://127.0.0.1:<port>`。
   - 选择目标 CLI = **Claude Code**,选择密钥,点击「一键写入」。
   - 选择目标 CLI = **Codex**,选择密钥,按需要勾选「同时写入用户环境变量」后点击「一键写入」。若未勾选,按返回的 `env_instructions` 设置 `LLM_GATEWAY_KEY` 并重启终端。
3. 打开 Claude Code,发送任意一条消息;确认请求出现在网关「日志」页。
4. 打开 Codex,发送任意一条消息;确认请求出现在网关「日志」页。
5. 若 Codex 流式模式表现异常,可改用非流式或在 `~/.codex/config.toml` 中调整相关设置,作为临时兜底。

> GUI/CLI 真实冒烟 **PENDING** 用户手动执行。
