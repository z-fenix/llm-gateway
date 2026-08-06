# llm-gateway 阶段 2 · 安全审计中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 核心网关上构建安全审计中心——风险检测引擎（凭证/路径/命令/Unicode/追踪像素/IP探测）、审计/警告/脱敏/阻断四模式、内置规则库 + 自定义黑白名单、日志风险标签 + findings 详情。

**Architecture:** 新增 `security/` 检测引擎模块（纯函数、独立可测），在 `proxy/handlers.rs` 请求侧与响应侧各插入一个检测点（方案 A：检测作用在统一格式 body 上）。阻断发生在转发上游之前；脱敏只改发往上游的 body；落库的 request_body 始终独立打码。流式 SSE 响应只审计、不回改已发出的 chunk。检测设置经 `AppState.security: Arc<RwLock<SecuritySettings>>` 共享（与 `fallback` 同模式），Tauri commands 改设置时同步 store + AppState。

**Tech Stack:** Rust + axum + rusqlite（新增 `security/`，不加重型依赖）；tauri-plugin-store；React + TS + Tailwind + React Router + Zustand；cargo test + vitest。

**Spec:** `docs/superpowers/specs/2026-08-06-llm-gateway-stage2-security-design.md`（检测规则全集、阈值矩阵、四模式语义以此为准）。

## Global Constraints

- 真实上游 `channels.api_key` 永不进前端、永不写进日志/错误/响应；扫描文本不含它。脱敏只改「发往上游的 body」，落库 `request_body` 始终走 `redact_json_for_logging` 打码（两信任边界解耦）。
- 阻断发生在转发上游**之前**，命中内容绝不发到上游；阻断返回 `451`，且仍写 request_log（`security_action='block'`）+ `request_security_findings`。
- 故障切换语义不变：仅 网络错误/超时/5xx/429/401/403 触发；4xx 业务错误不触发。安全阻断（451）不参与渠道重试/兜底。
- 四模式 = 全局模式 + 阈值：audit→Allow；warn→≥Medium 记 Warn；redact→≥High 脱敏；block→≥High 阻断；任何模式 `block_on_critical` 且 Critical → 强制 Block。
- 流式 SSE 响应**只审计**（findings 入库，phase=response），不回改已转发给下游的 chunk；非流式响应支持完整四模式。
- 自定义黑白名单 = 子串匹配（不支持正则），类别 domain/tool/path/keyword。
- `findings` 单请求上限 `MAX_FINDINGS = 80`；单字符串扫描上限 `max_scan_bytes`（默认 1 MiB）。
- 网关在无 UI 时也运行：设置必须存于 `AppState` 供网关读取，不能只读 store。
- DB 写入沿用「单 `Mutex<Connection>` 锁」模式；日志 `seq` 仍由 `insert_log` 内部原子分配，调用方传 `seq: 0`。
- 迁移经 `db/mod.rs` 的 `MIGRATIONS` 数组 + `_migrations` 版本表，新增 `002_security.sql`。
- 测试：cargo test（单元/集成，内存库 + mock 上游 `tests/common`）+ vitest（前端）。每个任务结束跑对应测试并提交。

---

### Task 1: 数据库 schema — security 迁移 + findings/规则 CRUD

**Files:**
- Create: `src-tauri/migrations/002_security.sql`
- Modify: `src-tauri/src/db/mod.rs`（MIGRATIONS 数组）
- Modify: `src-tauri/src/db/models.rs`（RequestLog 加 6 列 + SecurityFinding/BuiltinRule/CustomRule）
- Modify: `src-tauri/src/db/repository.rs`（insert_log 扩列 + findings/规则 CRUD）
- Test: `src-tauri/src/db/repository.rs` 末尾 `#[cfg(test)]`（若无则新建 `src-tauri/tests/security_repo.rs`）

**Interfaces:**
- Consumes: 现有 `Db::new_in_memory()`、`Repository`、`RequestLog`、`insert_log`（现 INSERT 22 列）。
- Produces: `RequestSecurityFinding`、`BuiltinRule`、`CustomRule` 结构体；`Repository::{insert_finding, get_findings, seed_builtin_rules, list_builtin_rules, update_builtin_rule, reset_builtin_rules, list_custom_rules, create_custom_rule, set_custom_rule_enabled, delete_custom_rule}`；扩展后的 `insert_log`（28 列）。

- [ ] **Step 1: 写迁移 SQL**

Create `src-tauri/migrations/002_security.sql`:

```sql
ALTER TABLE request_logs ADD COLUMN risk_level      TEXT NOT NULL DEFAULT 'clean';
ALTER TABLE request_logs ADD COLUMN risk_score      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN risk_summary    TEXT;
ALTER TABLE request_logs ADD COLUMN security_action TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE request_logs ADD COLUMN sanitized       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN blocked_reason  TEXT;
CREATE INDEX IF NOT EXISTS idx_logs_risk_level ON request_logs(risk_level);

CREATE TABLE IF NOT EXISTS request_security_findings (
  id TEXT PRIMARY KEY, log_id TEXT NOT NULL REFERENCES request_logs(id),
  phase TEXT NOT NULL, category TEXT NOT NULL, rule_id TEXT NOT NULL,
  severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  location TEXT, evidence_masked TEXT, evidence_hash TEXT, action TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_log  ON request_security_findings(log_id);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON request_security_findings(rule_id);

CREATE TABLE IF NOT EXISTS security_builtin_rules (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL,
  description TEXT, toggle_key TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_custom_rules (
  id TEXT PRIMARY KEY, rule_type TEXT NOT NULL, category TEXT NOT NULL,
  pattern TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
  action TEXT NOT NULL DEFAULT 'warn', enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_rules_type     ON security_custom_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_custom_rules_category ON security_custom_rules(category);
CREATE INDEX IF NOT EXISTS idx_custom_rules_enabled  ON security_custom_rules(enabled);
```

- [ ] **Step 2: 注册迁移**

Modify `src-tauri/src/db/mod.rs` line 9:

```rust
const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/001_init.sql"),
    include_str!("../../migrations/002_security.sql"),
];
```

- [ ] **Step 3: 扩展模型**

Modify `src-tauri/src/db/models.rs`：给 `RequestLog` 追加 6 个字段（`risk_level: String`、`risk_score: i64`、`risk_summary: Option<String>`、`security_action: String`、`sanitized: bool`、`blocked_reason: Option<String>`），并新增三个结构体：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestSecurityFinding {
    pub id: String, pub log_id: String, pub phase: String, pub category: String,
    pub rule_id: String, pub severity: String, pub title: String,
    pub description: Option<String>, pub location: Option<String>,
    pub evidence_masked: Option<String>, pub evidence_hash: Option<String>,
    pub action: Option<String>, pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinRule {
    pub id: String, pub rule_id: String, pub category: String, pub severity: String,
    pub title: String, pub description: Option<String>, pub toggle_key: Option<String>,
    pub enabled: bool, pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomRule {
    pub id: String, pub rule_type: String, pub category: String, pub pattern: String,
    pub severity: String, pub action: String, pub enabled: bool,
    pub description: Option<String>, pub created_at: i64,
}
```

- [ ] **Step 4: 扩展 `insert_log` 为 28 列**

Modify `insert_log`：INSERT 列表追加 `risk_level,risk_score,risk_summary,security_action,sanitized,blocked_reason`，VALUES 加到 `?28`，params 追加 `l.risk_level, l.risk_score, l.risk_summary, l.security_action, l.sanitized as i64, l.blocked_reason`（在 `l.created_at` 之前，列顺序与 SQL 一致）。`seq` 仍内部原子分配。

> 注意：`row_to_request_log`（list_logs/get 用）也要补读 6 个新列，否则 SELECT * 顺序错位。找到现有映射函数补齐。

- [ ] **Step 5: findings + 规则 CRUD**

Add to `Repository`（均单锁模式）：

```rust
pub fn insert_finding(&self, f: &RequestSecurityFinding) -> AppResult<()> {
    let conn = self.db.conn(); let conn = conn.lock().unwrap();
    conn.execute(
        "INSERT INTO request_security_findings (id,log_id,phase,category,rule_id,severity,title,description,location,evidence_masked,evidence_hash,action,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![f.id,f.log_id,f.phase,f.category,f.rule_id,f.severity,f.title,f.description,f.location,f.evidence_masked,f.evidence_hash,f.action,f.created_at],
    )?;
    Ok(())
}

pub fn get_findings(&self, log_id: &str) -> AppResult<Vec<RequestSecurityFinding>> {
    let conn = self.db.conn(); let conn = conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id,log_id,phase,category,rule_id,severity,title,description,location,evidence_masked,evidence_hash,action,created_at FROM request_security_findings WHERE log_id=?1 ORDER BY created_at ASC")?;
    let rows = stmt.query_map(params![log_id], |r| Ok(RequestSecurityFinding{
        id:r.get(0)?,log_id:r.get(1)?,phase:r.get(2)?,category:r.get(3)?,rule_id:r.get(4)?,
        severity:r.get(5)?,title:r.get(6)?,description:r.get(7)?,location:r.get(8)?,
        evidence_masked:r.get(9)?,evidence_hash:r.get(10)?,action:r.get(11)?,created_at:r.get(12)?,
    }))?;
    let mut out=Vec::new(); for x in rows { out.push(x?); } Ok(out)
}
```

`seed_builtin_rules`：对每条内置规则 `INSERT OR IGNORE`，内置规则全集见 Task 3（每条 `rule_id`/category/severity/title/toggle_key）。`list_builtin_rules`、`update_builtin_rule(id, enabled, severity)`、`reset_builtin_rules`（DELETE + seed）、`list_custom_rules`、`create_custom_rule`、`set_custom_rule_enabled(id,enabled)`、`delete_custom_rule(id)` 同模式（略，照上面 params 风格）。

- [ ] **Step 6: 测试（内存库）**

`Db::new_in_memory()` 现在应应用 001+002。测试：插入一个带风险列的 RequestLog → list 读回 6 列正确；insert_finding + get_findings 往返；seed 后 list_builtin_rules 非空且幂等（再 seed 不重复）；custom rule CRUD + 启停。

Run: `cargo test --manifest-path src-tauri/Cargo.toml db`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/migrations/002_security.sql src-tauri/src/db/
git commit -m "feat(stage2): security 迁移 + findings/规则 CRUD + request_logs 风险列"
```

---

### Task 2: 检测引擎类型 + 四模式决策（security/mod.rs）

**Files:**
- Create: `src-tauri/src/security/mod.rs`
- Modify: `src-tauri/src/lib.rs`（`pub mod security;`）
- Test: `src-tauri/src/security/mod.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Consumes: 无（纯类型 + 决策逻辑）。
- Produces: `RiskLevel{Clean,Info,Low,Medium,High,Critical}`(`rank()`)、`SecurityAction{Allow,Warn,Redact,Block}`(`as_str()`)、`SecurityFinding`、`SecurityScanResult`、`SecuritySettings`(`Default`)、`decide_action(&mut SecurityScanResult,&SecuritySettings)`。

- [ ] **Step 1: 写失败测试**

`decide_action` 阈值矩阵 + block_on_critical：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn res(level: RiskLevel) -> SecurityScanResult { SecurityScanResult { risk_level: level, risk_score: 0, action: SecurityAction::Allow, sanitized: false, blocked_reason: None, summary: "s".into(), findings: vec![] } }
    fn settings(mode: &str, boc: bool) -> SecuritySettings { SecuritySettings { enabled: true, mode: mode.into(), ..Default::default() } }

    #[test] fn audit_always_allow() { let mut r = res(RiskLevel::Critical); decide_action(&mut r, &settings("audit", false)); assert_eq!(r.action, SecurityAction::Allow); }
    #[test] fn warn_threshold_medium() {
        let mut lo = res(RiskLevel::Low); decide_action(&mut lo, &settings("warn", false)); assert_eq!(lo.action, SecurityAction::Allow);
        let mut md = res(RiskLevel::Medium); decide_action(&mut md, &settings("warn", false)); assert_eq!(md.action, SecurityAction::Warn);
    }
    #[test] fn redact_and_block_threshold_high() {
        let mut md = res(RiskLevel::Medium); decide_action(&mut md, &settings("redact", false)); assert_eq!(md.action, SecurityAction::Allow);
        let mut hi = res(RiskLevel::High); decide_action(&mut hi, &settings("redact", false)); assert_eq!(hi.action, SecurityAction::Redact);
        let mut hi2 = res(RiskLevel::High); decide_action(&mut hi2, &settings("block", false)); assert_eq!(hi2.action, SecurityAction::Block);
        assert!(hi2.blocked_reason.is_some());
    }
    #[test] fn block_on_critical_overrides() {
        let mut cr = res(RiskLevel::Critical); decide_action(&mut cr, &settings("warn", true)); assert_eq!(cr.action, SecurityAction::Block);
    }
    #[test] fn disabled_allows() { let mut r = res(RiskLevel::Critical); let mut s = settings("block", true); s.enabled = false; decide_action(&mut r, &s); assert_eq!(r.action, SecurityAction::Allow); }
}
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml security::`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现类型 + decide_action**

Create `src-tauri/src/security/mod.rs`：`RiskLevel`/`SecurityAction`（`as_str`）、`SecurityFinding`、`SecurityScanResult`（含 `Default`）、`SecuritySettings`（`Default`: enabled=true, mode="audit", scan_request=true, scan_response=false, scan_unicode/tools/network=true, redact_secrets=false, block_on_critical=false, max_scan_bytes=1MiB）、`decide_action`（按 Global Constraints 阈值矩阵；Block 时 `blocked_reason=Some(summary)`）。声明 `pub mod scanner; pub mod redact; pub mod rules;`（先建空壳见 Task 3/4）。`lib.rs` 加 `pub mod security;`。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml security::` → PASS
```bash
git add src-tauri/src/security/ src-tauri/src/lib.rs
git commit -m "feat(stage2): security 类型 + 四模式决策 decide_action"
```

---

### Task 3: scanner — 六类检测 + 风险评分

**Files:**
- Create: `src-tauri/src/security/scanner.rs`
- Modify: `src-tauri/src/security/mod.rs`（`scan_request`/`scan_response`）
- Test: `src-tauri/src/security/scanner.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 2 类型。
- Produces: `scan_json(value,&str phase,&SecuritySettings)->SecurityScanResult`；`mod.rs::scan_request(body,&s)`、`scan_response(body,&s)`。

检测规则全集以 spec §2.2 为准（六类 + 各级别 + 评分 bonus）。`MAX_FINDINGS=80`。`location` 用 JSON 路径（`$.messages[0].content`）。`evidence_masked` 用 `mask_evidence`（首尾保留）。

- [ ] **Step 1: 失败测试**——每类一条命中 + 不命中（含中文、零宽 U+200B、Bidi U+202E、变体 U+FE0F、私钥 PEM、`sk-`+24位、`ifconfig.me`、1x1 `<img>`、`.env`、`curl `+外联=exfiltration Critical）；评分多信号 bonus（credential+network=+25）；MAX_FINDINGS 截断。

- [ ] **Step 2: 实现 `scan_json` + 各 `scan_*`**

参照 spec §2.2 表逐条实现 `scan_credentials/scan_paths/scan_unicode/scan_network/scan_tool_risks/scan_tracking_pixel/scan_fingerprint_terms`；`walk_json` 递归；评分=最高级别分+叠加 bonus，min(100)，级别只升不降；`summarize` 生成中文摘要。`scan_request`/`scan_response` 包装（`enabled`/`scan_request`/`scan_response` 门控 + `decide_action`）。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml security::scanner` → PASS
```bash
git add src-tauri/src/security/
git commit -m "feat(stage2): scanner 六类检测 + 风险评分"
```

---

### Task 4: redact — 转发脱敏 + 落库脱敏 + 证据掩码

**Files:**
- Create: `src-tauri/src/security/redact.rs`
- Modify: `src-tauri/src/security/mod.rs`（`redact_request_body`）
- Test: `src-tauri/src/security/redact.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces: `redact_json(value,&SecuritySettings)->Value`、`redact_json_for_logging(value)->Value`、`mask_evidence(&str)->String`、`mod.rs::redact_request_body(body,&s)->(Value,bool)`。

- [ ] **Step 1: 失败测试**——sk-/Bearer/私钥PEM/JWT 打码（`sk-****xxxx`、私钥→`[REDACTED PRIVATE KEY]`）；嵌套 JSON + secret 字段名（authorization/cookie 等）整体打码；`redact_json` 仅在 `enabled && redact_secrets` 时改；`redact_json_for_logging` 无条件打码（与转发模式解耦）；mask_evidence 首尾保留。

- [ ] **Step 2: 实现**——`redact_value_in_place` 递归；`redact_string` 按 token 匹配 sk-/ghp_/AKIA/AIza/JWT，Bearer 前缀保 2 位 + `****`，PEM 私钥整体替换并去 body 行；`is_secret_field` 命中字段名整体 `mask_string`。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml security::redact` → PASS
```bash
git add src-tauri/src/security/
git commit -m "feat(stage2): redact 转发/落库脱敏 + 证据掩码"
```

---

### Task 5: rules — 内置规则 seed 全集 + 自定义黑白名单匹配

**Files:**
- Create: `src-tauri/src/security/rules.rs`
- Test: `src-tauri/src/security/rules.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 1 `BuiltinRule`/`CustomRule` + `seed_builtin_rules`；Task 3 scanner。
- Produces: `BUILTIN_RULES: &[(&str rule_id, &str category, &str severity, &str title, &str toggle_key)]`（Task 1 seed 用）；`apply_custom_rules(text,phase,location,&[CustomRule],&mut Vec<SecurityFinding>)`；`is_whitelisted(category,value,&[CustomRule])->bool`。

- [ ] **Step 1: 失败测试**——blacklist domain 子串命中→产生 custom finding；whitelist 命中→`is_whitelisted` true；disabled 规则被跳过；category 非 domain/tool/path/keyword 不匹配。

- [ ] **Step 2: 实现**——`BUILTIN_RULES` 全集（覆盖 spec §2.2 全部 rule_id）；`apply_custom_rules`（blacklist 且 category 匹配→`add_finding`，rule_id=`custom.{rule_type}.{category}`，severity 从 rule.severity 解析）；`is_whitelisted`（enabled whitelist 且 category 匹配且 value 含 pattern）。把 `apply_custom_rules` 接入 scanner 的 `scan_text`（custom rules 由调用方经 `SecuritySettings` 或参数传入——本任务先用函数，接线在 Task 6）。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml security::rules` → PASS
```bash
git add src-tauri/src/security/
git commit -m "feat(stage2): 内置规则全集 + 自定义黑白名单匹配"
```

---

### Task 6: SecuritySettings 接入 AppState + store

**Files:**
- Modify: `src-tauri/src/proxy/state.rs`（加 `security` 字段）
- Modify: `src-tauri/src/lib.rs`（setup 从 store 加载）
- Modify: `src-tauri/src/security/mod.rs`（`get_security_settings` from store + `merge`）
- Test: `src-tauri/tests/`（可在 Task 9 集成测试覆盖；本任务做单元级 store 读取）

**Interfaces:**
- Consumes: Task 2 `SecuritySettings`；Stage 1 `AppState.fallback` 模式。
- Produces: `AppState.security: Arc<RwLock<SecuritySettings>>`；`security::get_security_settings(app)->SecuritySettings`（读 store.bin `security.*`，缺失用 Default）；`security::apply_settings(state,&SecuritySettings)`（写 AppState）。

- [ ] **Step 1: 实现**——`state.rs` 加 `pub security: Arc<RwLock<SecuritySettings>>` 并在 `new` 初始化为 `Default`。`security/mod.rs` 加 `get_security_settings(app)`（仿 `set_fallback` 的 store 读取，`security.enabled`/`security.mode`/…逐键读，缺省用 Default）。`lib.rs` setup：构造 AppState 后 `*state.security.write().unwrap() = get_security_settings(&app.handle());`。

- [ ] **Step 2: 验证 + commit**

Run: `cargo build --manifest-path src-tauri/Cargo.toml` → 编译通过
```bash
git add src-tauri/src/proxy/state.rs src-tauri/src/lib.rs src-tauri/src/security/mod.rs
git commit -m "feat(stage2): SecuritySettings 接入 AppState + store 加载"
```

---

### Task 7: 请求侧检测 + 阻断/脱敏接入（security_hook）

**Files:**
- Create: `src-tauri/src/proxy/security_hook.rs`
- Modify: `src-tauri/src/proxy/mod.rs`（`pub mod security_hook;`）
- Modify: `src-tauri/src/proxy/handlers.rs`（`handle()` 插入请求侧检测）
- Test: `src-tauri/tests/security_request.rs`（新建，用 `tests/common` mock）

**Interfaces:**
- Consumes: Task 2-6 全部；Stage 1 `handle()`、`write_log`/`log_failure`、`insert_log`、自定义规则（`state.repo.list_custom_rules()`）。
- Produces: `security_hook::inspect_request(state, trace_id, api_key, proto, request_model, body) -> RequestVerdict`，其中 `enum RequestVerdict { Proceed(Value), Blocked(Response) }`（Proceed 携带可能被脱敏的 body）。

- [ ] **Step 1: 失败集成测试**——构造含 `sk-...`（24+位）的请求，mode=block → 期望 451、`request_log.security_action='block'`、findings 入库、mock 上游**未**收到；mode=redact → 上游收到打码 body、日志 `sanitized=1`；mode=audit → 放行但日志带 risk_level。

- [ ] **Step 2: 实现 `inspect_request`**——读 `state.security`；`scan_request(body, &settings)`（并入 `apply_custom_rules`，custom rules 从 `state.repo.list_custom_rules()`）；`decide_action`。Block→写 request_log（`security_action='block'`、`blocked_reason`、risk 列）+ findings，返回 451 `{error:{code:"blocked_by_security",trace_id,summary}}`。Redact→`redact_request_body`。Warn/Allow→原 body。把 verdict 的 risk 列/sanitized/action/findings 透出供后续写日志。

- [ ] **Step 3: 接入 `handle()`**——鉴权+解析出 `ChatRequest` 后、角色识别前调用；Blocked 直接早返回（与 log_failure 同路径写日志）；Proceed(redacted body) 用新 body 继续。落库的 `request_body` 始终 `redact_json_for_logging`。

- [ ] **Step 4: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test security_request` → PASS；再跑全量 `cargo test` 确保不回归
```bash
git add src-tauri/src/proxy/ src-tauri/tests/security_request.rs
git commit -m "feat(stage2): 请求侧检测 + 451阻断/脱敏接入"
```

---

### Task 8: 非流式响应侧检测

**Files:**
- Modify: `src-tauri/src/proxy/handlers.rs`（`handle()` 的 `Ok(fr)` 分支）
- Modify: `src-tauri/src/proxy/security_hook.rs`（`inspect_response`）
- Test: `src-tauri/tests/security_response.rs`

**Interfaces:**
- Consumes: `forwarder::Outcome.body`、`scan_response`、Task 7 hook。
- Produces: `security_hook::inspect_response(state, resp_body) -> SecurityScanResult`；非流式响应按四模式处理（block→451，redact→脱敏响应体，warn/allow→透传），findings phase=response 入库。

- [ ] **Step 1: 失败集成测试**——mock 上游返回含凭证的响应体，scan_response 开 + mode=block → 451；mode=audit → 透传但日志带 response findings。

- [ ] **Step 2: 实现**——`handle()` `Ok(fr)` 分支拿到 `fr.outcome.body` 后 `inspect_response`；按 action 处理；合并 findings（phase=response）到该请求的日志写入。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test security_response` → PASS
```bash
git add src-tauri/src/proxy/ src-tauri/tests/security_response.rs
git commit -m "feat(stage2): 非流式响应侧检测"
```

---

### Task 9: 流式响应审计（只审计，不回改 chunk）

**Files:**
- Modify: `src-tauri/src/proxy/sse.rs`（`SseAccumulator` 增加文本累积）
- Modify: `src-tauri/src/proxy/handlers.rs`（`handle_stream` 日志尾巴闭包）
- Test: `src-tauri/tests/security_stream.rs`

**Interfaces:**
- Consumes: Task 10 已修的 `handle_stream` SSE 累积/日志尾巴；`SseAccumulator`。
- Produces: `SseAccumulator` 新增 `text: String`（`feed_line` 里提取 delta content 追加）+ `pub fn text(&self)->&str`；`handle_stream` 日志尾巴对 `acc.text()` 做 `scan_response`，findings(phase=response) 入库。

- [ ] **Step 1: 失败集成测试**——流式上游吐出含风险词的 chunk，下游收到的 chunk **逐字节未被改动**，流结束后该请求日志带 response findings。

- [ ] **Step 2: 实现**——`SseAccumulator` 加 `text` 字段，`feed_line` 在解析出 delta content（OpenAI `choices[0].delta.content` / Anthropic `content_block_delta.delta.text`）时追加。`handle_stream` 日志尾巴闭包：用累积 `text` 包成 `serde_json::json!({"content": text})` 调 `scan_response`，findings 写入 `request_security_findings`（phase=response），并把 risk 列合并进该请求的 request_log。**不触碰已发出的 Bytes**。

- [ ] **Step 3: 测试通过 + commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test security_stream` → PASS；全量 `cargo test` 不回归
```bash
git add src-tauri/src/proxy/ src-tauri/tests/security_stream.rs
git commit -m "feat(stage2): 流式响应审计（findings 入库，不改 chunk）"
```

---

### Task 10: Tauri commands + 前端 api/types

**Files:**
- Create: `src-tauri/src/commands/security.rs`
- Modify: `src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs`（注册 handler）
- Modify: `src/types/index.ts`、`src/lib/api.ts`
- Test: 前端 vitest 在 Task 11；本任务保证 `cargo build` + `tsc --noEmit` 通过

**Interfaces:**
- Consumes: Task 1 CRUD、Task 6 settings。
- Produces: commands `get_security_settings/set_security_setting/get_builtin_security_rules/update_builtin_security_rule/reset_builtin_security_rules/get_custom_security_rules/create_custom_security_rule/toggle_custom_security_rule/delete_custom_security_rule/get_security_findings`；TS 类型 `SecuritySettings/BuiltinRule/CustomRule/SecurityFinding`；`api.*` 封装。

- [ ] **Step 1: 实现 commands**——仿 `role_route.rs`/`log.rs` 风格。`get_security_settings` 读 `state.security`；`set_security_setting(key,value)` 更新 `state.security` 对应字段 + 写 store（仿 `set_fallback`）。规则 CRUD 调 Task 1 repository；`get_builtin_security_rules` 空则 seed。`get_security_findings(log_id)` 调 `get_findings`。`lib.rs` `generate_handler!` 注册全部。

- [ ] **Step 2: 前端类型 + api**——`types/index.ts` 加四接口；`api.ts` 加封装（snake_case 参数，仿现有）。

- [ ] **Step 3: 验证 + commit**

Run: `cargo build --manifest-path src-tauri/Cargo.toml` 通过；`pnpm typecheck` 通过
```bash
git add src-tauri/src/commands/ src-tauri/src/lib.rs src/types/index.ts src/lib/api.ts
git commit -m "feat(stage2): security Tauri commands + 前端 api/types"
```

---

### Task 11: SecurityPage + 路由 + LogsPage 风险标签

**Files:**
- Create: `src/pages/SecurityPage.tsx`
- Modify: `src/App.tsx`（`/security` 路由）、`src/components/Layout.tsx`（导航）
- Modify: `src/pages/LogsPage.tsx`（风险标签 + findings 详情）
- Test: `src/pages/__tests__/SecurityPage.test.tsx`

**Interfaces:**
- Consumes: Task 10 api/types；Stage 1 Layout/LogsPage 结构。
- Produces: SecurityPage 三分区（总开关+模式 / 内置规则 / 自定义黑白名单）；LogsPage 风险彩色标签 + 展开时 findings 列表。

- [ ] **Step 1: 失败 vitest**——mock `api.ts`，断言 SecurityPage 渲染三分区、模式单选可切换（调 `setSecuritySetting`）、内置规则行有启停开关。

- [ ] **Step 2: 实现 SecurityPage**——三个分区仿 Stage 1 页（Tailwind 卡片/表格/按钮）。设置区：enabled 开关、四模式单选、block_on_critical、各扫描开关、max_scan_bytes 输入。内置规则表：rule_id/类别/级别/标题 + 启停 toggle + 级别下拉 + 「重置默认」。自定义规则表 + 新增表单（rule_type/category/pattern/severity/action）+ 行内启停/删除。

- [ ] **Step 3: LogsPage 风险标签 + findings**——列表行按 `risk_level` 渲染彩色徽章（clean 灰/info 蓝/low 绿/medium 黄/high 橙/critical 红）+ `security_action` 标记（blocked 红 / sanitized「已脱敏」）；展开详情若 `risk_level!='clean'` 则 `getSecurityFindings(id)` 逐条展示（severity/title/description/evidence_masked）。路由 + 导航加「安全审计」。

- [ ] **Step 4: 测试通过 + commit**

Run: `pnpm test:unit` → PASS；`pnpm typecheck` 通过
```bash
git add src/pages/ src/App.tsx src/components/Layout.tsx
git commit -m "feat(stage2): SecurityPage + 路由 + LogsPage 风险标签与 findings 详情"
```

---

## Self-Review 记录

- **Spec 覆盖**：六类检测(T3)、四模式(T2)、脱敏(T4)、黑白名单(T5)、请求/非流式/流式插入点(T7/8/9)、设置接入(T6)、commands+前端(T10/11)、日志标签(T11)——均有对应任务。findings 上限/扫描字节上限在 T2/T3 Global Constraints。
- **Placeholder 扫描**：无 TBD/TODO；Task 1 的「其余 CRUD 略」刻意指向已给的 params 风格样例（同文件同模式），非占位。
- **类型一致性**：`SecuritySettings`/`SecurityFinding`/`RequestSecurityFinding`/`CustomRule`/`BuiltinRule` 命名在 T1/T2/T10/TS 间一致；`inspect_request`/`inspect_response` 签名在 T7/T8 一致；`AppState.security` 在 T6/T7/T10 一致。
- **风险点**：Task 1 改 `RequestLog` 加列会破坏现有 `row_to_request_log` 与所有 `RequestLog{}` 字面量构造点（handlers.rs 多处）——实施者须全量编译修复；这是预期的编译器驱动重构。
