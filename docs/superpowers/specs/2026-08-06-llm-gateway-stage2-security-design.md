# llm-gateway 阶段 2 · 安全审计中心 设计文档

> 在阶段 1 核心网关之上，构建风险检测引擎与审计/警告/脱敏/阻断四模式安全审计中心。
> 功能对齐 WaLiAPI 的 `security/` 模块，架构沿用阶段 1 的「统一格式上检测」原则。

- 日期：2026-08-06
- 状态：已确认（数据模型、引擎模块、管线插入点、前端页均经用户逐段确认）
- 项目位置：`/Users/zhouqiao/workplace/project/llm-gateway`
- 前置：阶段 1 核心网关已合并到 `master`（HEAD `485a3c3`）

---

## 0. 目标与范围

在阶段 1 的请求管线上加入**安全审计中心**：

- **风险检测引擎**：凭证泄露 / 敏感路径 / 命令外联 / Unicode 隐写 / 追踪像素 / 公网 IP 探测，外加账号画像上下文与本地路径泄露。
- **四模式**：审计 / 警告 / 脱敏 / 阻断（全局模式 + 风险阈值，见 §3.4）。
- **内置规则库**（可启停、可调级别）+ **自定义黑白名单**（domain/tool/path/keyword 子串匹配）。
- **检测范围**：请求侧 + 响应侧全量；流式 SSE 响应只审计（不回改已发出的 chunk）。
- **日志页**：风险等级标签 + findings 详情面板。

**已确认的关键决策**：
1. 四模式 = 全局模式 + 阈值（与 WaLiAPI 一致），非每规则独立模式。
2. 检测范围 = 请求 + 响应全量；流式响应侧只审计，不做脱敏/阻断。
3. 自定义规则 = 子串匹配（不支持正则），与 WaLiAPI 一致。
4. 日志展示 = request_logs 风险列做列表标签 + findings 独立表做详情面板。

---

## 1. 数据模型（SQLite）

一次迁移 `002_security.sql`。沿用阶段 1 的 rusqlite 仓储（`db/repository.rs`）。

### 1.1 `request_logs` 增加 6 个风险列

用于列表页彩色标签 + 按风险筛选（衔接阶段 3 日志审计增强）。

```sql
ALTER TABLE request_logs ADD COLUMN risk_level      TEXT NOT NULL DEFAULT 'clean';
ALTER TABLE request_logs ADD COLUMN risk_score      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN risk_summary    TEXT;
ALTER TABLE request_logs ADD COLUMN security_action TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE request_logs ADD COLUMN sanitized       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN blocked_reason  TEXT;
CREATE INDEX idx_logs_risk_level ON request_logs(risk_level);
```

### 1.2 新增 3 张表

```sql
-- 每次请求的逐条检测发现（详情面板逐条展示）
CREATE TABLE request_security_findings (
  id              TEXT PRIMARY KEY,
  log_id          TEXT NOT NULL REFERENCES request_logs(id),
  phase           TEXT NOT NULL,          -- request | response
  category        TEXT NOT NULL,          -- credential|file|unicode|network|tool|prompt|infra|custom
  rule_id         TEXT NOT NULL,
  severity        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  location        TEXT,
  evidence_masked TEXT,                   -- 落库前已打码（sk-****xxxx）
  evidence_hash   TEXT,                   -- 去重/核对，不存明文
  action          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_findings_log  ON request_security_findings(log_id);
CREATE INDEX idx_findings_rule ON request_security_findings(rule_id);

-- 内置规则（检测逻辑硬编码于 scanner，DB 只存 启停/级别 覆盖 + 展示文案）
CREATE TABLE security_builtin_rules (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',
  title       TEXT NOT NULL,
  description TEXT,
  toggle_key  TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 自定义黑白名单（子串匹配）
CREATE TABLE security_custom_rules (
  id          TEXT PRIMARY KEY,
  rule_type   TEXT NOT NULL,                -- blacklist | whitelist
  category    TEXT NOT NULL,                -- domain | tool | path | keyword
  pattern     TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',
  action      TEXT NOT NULL DEFAULT 'warn',
  enabled     INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_custom_rules_type     ON security_custom_rules(rule_type);
CREATE INDEX idx_custom_rules_category ON security_custom_rules(category);
CREATE INDEX idx_custom_rules_enabled  ON security_custom_rules(enabled);
```

**设计说明**：
- **findings 独立成表**：一次请求的发现逐条入库（上限 `MAX_FINDINGS=80`），详情面板逐条展示；`evidence_masked` 落库前已打码，`evidence_hash` 用于去重而不存明文。
- **内置规则逻辑不落库**：检测代码硬编码，DB 表只存启停与级别覆盖，避免把可执行规则塞进 SQL（与 WaLiAPI 一致）。
- **全局安全设置不进 SQLite**：enabled/mode/各类扫描开关沿用阶段 1 的 `tauri-plugin-store`（`security.*` 键）。

---

## 2. 检测引擎模块划分

新增 `src-tauri/src/security/`，职责单一、可独立测试：

```
security/
├── mod.rs        # 类型 + 决策 + 对外入口
├── scanner.rs    # 纯检测：scan_json 遍历 JSON → 逐字符串跑各类规则；风险评分
├── redact.rs     # redact_json(转发前) / redact_json_for_logging(落库前)；证据掩码
└── rules.rs      # 内置规则 seed + CRUD；自定义黑白名单匹配
```

### 2.1 核心类型（`mod.rs`）

```rust
pub enum RiskLevel { Clean, Info, Low, Medium, High, Critical }   // rank() 0-5
pub enum SecurityAction { Allow, Warn, Redact, Block }

pub struct SecurityFinding {
    pub phase: String,          // request | response
    pub category: String,
    pub rule_id: String,
    pub severity: RiskLevel,
    pub title: String,
    pub description: String,
    pub location: String,       // JSON 路径，如 $.messages[0].content
    pub evidence_masked: String,
}

pub struct SecurityScanResult {
    pub risk_level: RiskLevel,
    pub risk_score: i32,        // 0-100
    pub action: SecurityAction,
    pub sanitized: bool,
    pub blocked_reason: Option<String>,
    pub summary: String,
    pub findings: Vec<SecurityFinding>,
}

pub struct SecuritySettings {
    pub enabled: bool,
    pub mode: String,           // audit | warn | redact | block
    pub scan_request: bool,
    pub scan_response: bool,
    pub scan_unicode: bool,
    pub scan_tools: bool,
    pub scan_network: bool,
    pub redact_secrets: bool,
    pub block_on_critical: bool,
    pub max_scan_bytes: usize,
}
```

对外入口：

```rust
pub fn scan_request(body: &serde_json::Value, s: &SecuritySettings) -> SecurityScanResult;   // phase="request"
pub fn scan_response(body: &serde_json::Value, s: &SecuritySettings) -> SecurityScanResult;  // phase="response"
pub fn decide_action(result: &mut SecurityScanResult, s: &SecuritySettings);
pub fn redact_request_body(body: &serde_json::Value, s: &SecuritySettings) -> (serde_json::Value, bool);
pub fn get_security_settings(app: &AppHandle) -> SecuritySettings;   // 读 tauri-plugin-store
```

### 2.2 六类内置检测（`scanner.rs`）

`scan_json` 深度遍历 JSON，对每个字符串调用各类检测；`MAX_FINDINGS = 80` 防止超大 body 拖垮。

| category | rule_id | 级别 | 说明 |
|---|---|---|---|
| credential 凭证泄露 | `credential.secret_token` | High | sk-(≥24)/sk-ant-/ghp_/gho_/xoxb-/AKIA/AIza/JWT(eyJ…)/Bearer |
| | `credential.private_key` | Critical | PEM/OpenSSH 私钥头 |
| | `credential.named_secret` | High | authorization:/cookie:/sessionid=/secret_key/access_key/database_url 字段名 |
| file 敏感路径 | `file.sensitive_path` | High | .env / ~/.ssh / id_rsa / id_ed25519 / .aws/credentials / .git-credentials / .netrc / .npmrc / credentials.json |
| tool 命令外联 | `tool.shell.network_or_exec` | Medium | curl/wget/nc/ncat/scp/rsync/bash -c/sh -c/python -c/node -e/powershell/osascript |
| | `tool.shell.exfiltration` | Critical | 同时含「读敏感(cat .env/printenv/base64 ~/.ssh…)」+「网络外联」 |
| unicode 隐写 | `unicode.zero_width` | Medium | U+200B/200C/200D/2060/FEFF |
| | `unicode.bidi_control` | High | U+202A-202E / U+2066-2069 方向控制 |
| | `unicode.variation_selector` | Medium | U+FE00-FE0F / U+E0100-E01EF 变体选择符 |
| network 追踪像素/IP探测 | `html.tracking_pixel` | High | 远程 img 且 1x1/track/pixel/beacon 特征 |
| | `network.ip_probe` | High | ifconfig.me/ipinfo.io/ip-api.com/ipify.org/ident.me/icanhazip.com/api.ip.sb |
| | `network.suspicious_domain` | High | webhook.site/requestbin/ngrok/trycloudflare/pastebin/transfer.sh/file.io |
| | `network.external_url` | Info | 含 http(s):// 外部 URL |
| prompt 账号画像 | `prompt.fingerprint_context` | Medium | ≥2 个 时区/代理/指纹/风控/隐写 相关词 |
| infra 本地路径 | `infra.local_path` | Medium | /Users/ / C:\Users\ / /home/ |

### 2.3 风险评分（`scanner.rs`）

- 基础分 = 所有 findings 中按级别取最高（Clean0/Info5/Low15/Medium35/High65/Critical90）。
- 多信号叠加 bonus：credential+network=+25；sensitive_file+network=+25；unicode+network=+15；shell+sensitive_file=+20。
- `score = min(100, score)`；`score>=90→Critical`、`>=65→High`、`>=35→Medium`（只升不降）。
- `risk_score` 用于排序/筛选，`risk_level` 用于决策与标签。

### 2.4 四模式决策 `decide_action`（全局模式 + 阈值）

```
mode=audit  → Allow（只记录）
mode=warn   → risk_level >= Medium 记 Warn（仍放行，标注），否则 Allow
mode=redact → risk_level >= High   → Redact（脱敏后转发），否则 Allow
mode=block  → risk_level >= High   → Block（阻断），否则 Allow
任何模式：block_on_critical 开 且 risk_level==Critical → 强制 Block
Block 时 blocked_reason = summary
```

### 2.5 脱敏（`redact.rs`）

- `redact_json`（转发前）：仅当 `enabled && redact_secrets` 时，把 body 里的密钥/Bearer/私钥PEM/JWT 打码（`sk-****xxxx`、私钥整体替换为 `[REDACTED PRIVATE KEY]`）。
- `redact_json_for_logging`（落库前）：**与转发脱敏解耦**。即使 audit 模式放行原始请求，落库的 `request_body` 也始终把命中的密钥打码——日志永不明文存密钥（刻意的信任边界，沿用 WaLiAPI）。
- `evidence_masked`：findings 证据落库前打码（首尾保留 + 中间 `****`）。

---

## 3. 管线插入点（方案 A）

在现有管线上加两个检测点，请求侧一个、响应侧一个。检测只依赖「统一格式 body」，与协议/渠道无关。

```
协议识别 → 鉴权+配额 → 解析统一ChatRequest
   │
   ├─【请求侧检测】scan_request(body) → decide_action
   │     Block : 写日志(security_action=block, findings入库) → 返回 451 {error, trace_id, summary}
   │     Redact: body = redact_request_body(body) → sanitized=1，继续转发
   │     Warn/Allow: 继续转发（action 记日志）
   ▼
角色识别 → 渠道调度 → 模型映射 → 协议转换 → 转发上游
   │
   ├─【响应侧检测】
   │   非流式: 拿到完整响应体 → scan_response(resp_body) → 同样四模式
   │   流式  : SSE 累积闭包里、日志落库前对累积完整文本只读扫描 → 只审计(findings入库)，不回改已发出 chunk
   ▼
日志 + Token 入库（带 risk_level/risk_score/security_action/sanitized，findings 落 request_security_findings）
```

**具体落点**（对应阶段 1 现有代码）：

- **请求侧**：`handle()`（`proxy/handlers.rs`）在鉴权、解析出 `ChatRequest` 之后、角色识别之前，插入薄封装 `proxy/security_hook.rs::inspect_request(...)`。阻断直接早返回 451，并沿用 `log_failure`/`write_log` 把该请求写进日志（保持阶段 1「所有请求都有日志」约束），同时写 `request_security_findings`。
- **非流式响应侧**：`handle()` 的 `Ok(fr)` 分支，拿到 `fr.outcome.body` 后 `scan_response`。
- **流式响应侧**：`handle_stream()` 末尾 `.chain(stream::once(...))` 的日志尾巴闭包里，把累积的完整文本喂给 `scan_response`，findings 随请求日志一起入库。**不触碰已转发给下游的 chunk**。
- **脱敏优先级**：请求侧 redact 只改「发往上游的 body」；落库的 `request_body` 始终走 `redact_json_for_logging`（独立于转发模式）。

**安全约束保持**：真实上游 `channels.api_key` 依旧只在转发时注入 header，扫描文本不含它；阻断发生在转发前，命中内容不会发到上游。

---

## 4. 前端页与 Tauri Commands

### 4.1 新增「安全审计」页 `SecurityPage.tsx`（路由 `/security`，导航加一项）

三个分区：

1. **总开关与模式**：enabled 开关 + 四模式单选（审计/警告/脱敏/阻断）+ 「Critical 强制阻断」开关 + 各扫描类别开关（unicode/tools/network/response）+ `max_scan_bytes`。存 `tauri-plugin-store`。
2. **内置规则列表**：表格展示 rule_id/类别/级别/标题，每行可启停、可改级别；「重置为默认」按钮。
3. **自定义黑白名单**：表格 + 新增表单（类型 black/white、类别 domain/tool/path/keyword、pattern、级别、动作），每行可启停/删除。

### 4.2 日志页 `LogsPage.tsx` 增强

- 列表每行加**风险等级彩色标签**（clean 灰/info 蓝/low 绿/medium 黄/high 橙/critical 红）+ security_action 标记（blocked 红字/sanitized 标「已脱敏」）。
- 展开详情时，若该请求有 findings，拉取 `request_security_findings` 逐条展示（级别、标题、描述、打码证据）。

### 4.3 新增 Tauri Commands（`commands/security.rs`）

- `get_security_settings` / `set_security_setting`（读写 store）
- `get_builtin_security_rules`（空则自动 seed）/ `update_builtin_security_rule` / `reset_builtin_security_rules`
- `get_custom_security_rules` / `create_custom_security_rule` / `toggle_custom_security_rule` / `delete_custom_security_rule`
- `get_security_findings(log_id)`（日志详情面板用）

前端在 `src/types/index.ts` 加 `BuiltinRule`/`CustomRule`/`SecurityFinding`/`SecuritySettings` 类型，`src/lib/api.ts` 加对应 invoke 封装，`App.tsx` 加 `/security` 路由。

---

## 5. 错误处理

| 场景 | 行为 | 返回 |
|---|---|---|
| 请求命中 block 阈值 / Critical 强制阻断 | 不转发上游，写日志 + findings | `451 {error:"blocked_by_security", trace_id, summary}` |
| 请求命中 redact 阈值 | 脱敏后转发，`sanitized=1` | 正常上游响应 |
| 请求命中 warn 阈值 | 放行，`security_action=warn` 记日志 | 正常上游响应 |
| 扫描本身出错（不应发生） | 放行并记日志，不影响主流程 | 正常上游响应 |
| 流式响应命中风险 | 只审计，findings 入库，不回改 chunk | 正常 SSE 流 |

所有阻断都写日志（含 trace_id、blocked_reason、findings），调用方拿 trace_id 可在日志页定位。

---

## 6. 测试策略（TDD）

- **scanner 单测**：六类规则各自的命中/不命中（含中文、多字节、零宽/Bidi/变体选择符字符）、`MAX_FINDINGS` 上限、风险评分与多信号 bonus。
- **decide_action 单测**：四模式 × 各 risk_level 阈值矩阵 + block_on_critical 覆盖。
- **redact 单测**：sk-/Bearer/私钥PEM/JWT 打码、`redact_json_for_logging` 与转发脱敏解耦、嵌套 JSON、secret 字段名（authorization 等）。
- **rules 单测**：自定义黑白名单子串匹配（domain/tool/path/keyword）、whitelist 抑制、启停过滤。
- **集成测试**（mock 上游，沿用阶段 1 `tests/common`）：
  - 请求命中阻断 → 451 + request_log(security_action=block) + findings 入库，上游未收到；
  - 请求命中脱敏 → 上游收到打码 body，日志 sanitized=1；
  - 流式响应审计 → findings(phase=response) 入库，下游 chunk 未被改动；
  - 非流式响应命中 → 按模式处理。
- **前端 vitest**：SecurityPage（三分区渲染 + 模式选择 + 规则启停调用），LogsPage 风险标签渲染。

---

## 7. 技术栈（沿用阶段 1）

| 层 | 技术 |
|---|---|
| 后端 | Rust + axum + rusqlite（新增 `security/` 模块，不新增重型依赖） |
| 配置存储 | tauri-plugin-store（`security.*` 键） |
| 数据库迁移 | `src-tauri/migrations/002_security.sql` |
| 前端 | React + TS + Tailwind + React Router + Zustand（新增 SecurityPage） |
| 测试 | cargo test（单元/集成）+ vitest（前端） |

---

[WaLiAPI]: /Users/zhouqiao/workplace/project/WaLiAPI
