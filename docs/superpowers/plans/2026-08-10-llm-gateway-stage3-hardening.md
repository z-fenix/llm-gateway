# Stage 3 · 完善与加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加固两阶段累积的 deferred 项——锁/错误处理(parking_lot)、正确性边界(quota/SSE/decide)、后端测试补强、前端 UX,不引入新特性。

**Architecture:** 纯加固,沿用现有架构。parking_lot 替换 std 锁消除 poison;quota 改单条原子 UPDATE;SSE buffer 限长 + mid-stream 错误透传;decide_action 复位/warn;其余为测试与前端 UX 补齐。

**Tech Stack:** Rust (Tauri 2 / axum / rusqlite / parking_lot)、React + TypeScript + vitest、Tailwind。

## Global Constraints

- 安全不变量不得回归:真实 `channels.api_key` 永不泄露(仅转发注入 header,前端见 masked);阻断先于转发;落库脱敏无条件(`redact_json_for_logging`);escalate-only 风险合并;findings 按 phase 关联正确 log_id;流式 chunk 逐字节不改。
- 每任务验收:`cargo test --manifest-path src-tauri/Cargo.toml`、`pnpm test:unit`、`pnpm typecheck` 全绿。
- 不引入新功能/新页面/新协议;不做无关重构。
- 锁迁移后全代码库不再出现 `lock().unwrap()` / `read().unwrap()` / `write().unwrap()`(测试 mock 内 `Mutex` 除外,见 Task 1 说明)。
- 提交信息以 `feat(stage3):` / `fix(stage3):` / `test(stage3):` 前缀。
- 分支:`feat/stage3-hardening`,BASE = spec commit `e7e7693`。

---

### Task 1: parking_lot 迁移(锁 poison 消除)

**Files:**
- Modify: `src-tauri/Cargo.toml`(加依赖)
- Modify: `src-tauri/src/db/mod.rs`(`Db.conn` 类型 + `conn()` 返回)
- Modify: `src-tauri/src/proxy/state.rs`(`fallback`/`security` 类型)
- Modify: `src-tauri/src/proxy/handlers.rs`、`src-tauri/src/proxy/security_hook.rs`、`src-tauri/src/router/role.rs`、`src-tauri/src/commands/*.rs`(删 `.unwrap()`)
- 不动: `src-tauri/tests/common/mod.rs`(测试内 `std::sync::Mutex` 保留,见下)

**Interfaces:**
- Consumes: 现有 `Db`/`AppState` 全部调用点。
- Produces: `Db::conn(&self) -> Arc<parking_lot::Mutex<Connection>>`;`AppState.fallback: Arc<parking_lot::RwLock<Option<(String,String)>>>`;`AppState.security: Arc<parking_lot::RwLock<SecuritySettings>>`。parking_lot 的 `lock()/read()/write()` 直接返回 guard(非 `Result`)。

注:生产代码全部迁到 parking_lot;`tests/common/mod.rs` 的 `MockUpstream` 用 `std::sync::Mutex` 属测试辅助,保留 std 即可(其 `.lock().unwrap()` 不在生产路径)。本任务只改 `src/`。

- [ ] **Step 1: 加依赖**

`src-tauri/Cargo.toml` 的 `[dependencies]` 段加一行:
```toml
parking_lot = "0.12"
```
Run: `cargo build --manifest-path src-tauri/Cargo.toml` → 预期编译通过(依赖拉取)。

- [ ] **Step 2: 改 `Db`**

`src-tauri/src/db/mod.rs`:
- `use std::sync::{Arc, Mutex};` → `use std::sync::Arc;` + `use parking_lot::Mutex;`
- `pub fn conn(&self) -> Arc<Mutex<Connection>>` 返回类型随 `Mutex` 改为 parking_lot(签名文本不变,因 `Mutex` 现在是 parking_lot 的)。

- [ ] **Step 3: 改 `AppState`**

`src-tauri/src/proxy/state.rs`:
- `use std::sync::{Arc, RwLock};` → `use std::sync::Arc;` + `use parking_lot::RwLock;`
- `fallback`/`security` 字段类型文本不变(`RwLock` 现为 parking_lot)。

- [ ] **Step 4: 全量编译,逐个删掉 `.unwrap()`**

Run: `cargo build --manifest-path src-tauri/Cargo.toml` 2>&1
预期:大量 `error[E0599]: no method named unwrap found`(parking_lot guard 无 unwrap)。逐文件删除生产代码里的 `.lock().unwrap()`→`.lock()`、`.read().unwrap()`→`.read()`、`.write().unwrap()`→`.write()`:
- `src/db/repository.rs`(全部 `conn.lock().unwrap()`→`conn.lock()`)
- `src/router/role.rs:68,84`
- `src/proxy/handlers.rs`(`acc.lock().unwrap()`、`state.security.read().unwrap()` 等)
- `src/proxy/security_hook.rs`(`state.security.read().unwrap()`)
- `src/proxy/forwarder.rs`、`src/commands/*.rs`、`src/lib.rs`(若有)
直到 `cargo build` 干净。

- [ ] **Step 5: 残留校验 + 测试**

Run: `grep -rn "lock().unwrap()\|read().unwrap()\|write().unwrap()" src-tauri/src --include="*.rs"` → 预期无输出(0 残留)。
Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿(行为不变,仅锁类型)。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/
git commit -m "feat(stage3): parking_lot 迁移消除锁 poison"
```

---

### Task 2: 吞错误统一改 `log::error!`

**Files:**
- Modify: `src-tauri/src/proxy/handlers.rs`(consume_quota / 残留 insert_log / write_log 调用点的 `let _`)
- Modify: `src-tauri/src/commands/role_route.rs`、`src-tauri/src/commands/security.rs`(store `set`/`save` 的 `let _`)
- 依赖: Task 1 完成(锁已迁,这些点不再有 `.unwrap()`)

**Interfaces:**
- Consumes: Task 1 的 parking_lot `AppState`/`Db`。
- Produces: 无新签名;仅把静默 `let _ = <expr>;`(expr 返回 `Result`)改为 `if let Err(e) = <expr> { log::error!("<上下文>: {}", e); }`。

- [ ] **Step 1: 找出生产代码所有吞错误的 `let _ =`**

Run: `grep -rn "let _ = " src-tauri/src --include="*.rs"`
逐个确认是否吞 `Result`(DB / store 写)。**保留**对非 Result 的忽略(如 `let _ = store.set(...)` 若返回 `()`,以及有意丢弃的 `Sender`/`Handle`)。只改吞 `Result` 的。

- [ ] **Step 2: handlers.rs 的 quota/log 吞错改 log::error!**

典型改法(以 consume_quota 为例,`handlers.rs` 非流式与流式两处):
```rust
// 改前
let _ = state2.repo.consume_quota(&api_key2.id, total);
// 改后
if let Err(e) = state2.repo.consume_quota(&api_key2.id, total) {
    log::error!("failed to consume quota: {}", e);
}
```
对 `let _ = write_log(...)` / `let _ = state.repo.insert_log(...)` 同理(write_log 返回 `AppResult<String>`,改成 `if let Err(e) = write_log(...) { log::error!("failed to write request log: {}", e); }`)。

- [ ] **Step 3: store 读写吞错改 log::error!**

`commands/role_route.rs` `set_fallback`/`clear_fallback`、`commands/security.rs` `set_security_setting`:
```rust
// 改前
let _ = store.set("fallback", value);
let _ = store.save();
// 改后
if let Err(e) = store.set("fallback", value) { log::error!("store set fallback failed: {}", e); }
if let Err(e) = store.save() { log::error!("store save failed: {}", e); }
```

- [ ] **Step 4: 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿(纯日志增强,无行为变化)。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/
git commit -m "fix(stage3): 吞 DB/store 错误统一改 log::error!"
```

---

### Task 3: quota 原子化(消除 check-then-consume 竞态)

**Files:**
- Modify: `src-tauri/src/db/repository.rs:100-109`(`consume_quota`)
- Test: `src-tauri/src/db/repository.rs` 的 `#[cfg(test)]`(或现有 db 测试模块)

**Interfaces:**
- Consumes: Task 1 的 parking_lot `Db`。
- Produces: `consume_quota(&self, key_id: &str, tokens: i64) -> AppResult<bool>` —— 改为返回 `bool`:`true`=已扣减,`false`=因超配(quota_total 非空且 `quota_used+tokens > quota_total`)未扣减。调用方按 bool 决定是否拒绝。

**注意:** 现签名返回 `AppResult<()>` 且无 quota 上限判断(超配也照扣)。本任务把它改成「带条件 UPDATE + 行数判断」。调用点(`handlers.rs` 非流式 ~:237 与流式尾巴)当前不检查返回,改为:非流式在 `forward` 前的 quota 预检保留现状(若有),扣减处若返回 `false` 仅 `log::error!`(不改变响应——配额属于事后统计,超配拒绝属于请求前校验,不在本任务)。**本任务只让扣减原子化并可观测,不改变请求放行为。**

- [ ] **Step 1: 失败测试**

在 `repository.rs` 测试模块加:
```rust
#[test]
fn consume_quota_atomic_caps_at_total() {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db);
    let mut k = api_key_fixture("k1");          // 复用现有 fixture;quota_total=Some(10), quota_used=0
    k.quota_total = Some(10);
    repo.insert_api_key(&k).unwrap();
    assert!(repo.consume_quota("k1", 6).unwrap());   // 0+6<=10 → true, used=6
    assert!(!repo.consume_quota("k1", 6).unwrap());  // 6+6>10 → false, used 仍 6
    let got = repo.get_api_key("k1").unwrap().unwrap();
    assert_eq!(got.quota_used, 6);
}
```
(若 `api_key_fixture`/`get_api_key` 名称不同,用现有测试里的实际辅助函数。)
Run: `cargo test --manifest-path src-tauri/Cargo.toml consume_quota_atomic` → FAIL(当前无上限判断,第二个断言会得 true)。

- [ ] **Step 2: 实现原子 UPDATE**

```rust
pub fn consume_quota(&self, key_id: &str, tokens: i64) -> AppResult<bool> {
    let conn = self.db.conn();
    let conn = conn.lock();
    let n = conn.execute(
        "UPDATE api_keys SET quota_used=quota_used+?1, total_tokens=total_tokens+?1,
         total_calls=total_calls+1, last_used_at=?2
         WHERE id=?3 AND (quota_total IS NULL OR quota_used+?1<=quota_total)",
        rusqlite::params![tokens, chrono::Utc::now().timestamp(), key_id],
    )?;
    Ok(n > 0)
}
```

- [ ] **Step 3: 修调用点**

`handlers.rs` 两处 `consume_quota` 调用改为接收 bool:
```rust
match state2.repo.consume_quota(&api_key2.id, total) {
    Ok(true) => {}
    Ok(false) => log::error!("quota exceeded for key {}: consume skipped", api_key2.id),
    Err(e) => log::error!("failed to consume quota: {}", e),
}
```
Run: `cargo build --manifest-path src-tauri/Cargo.toml` → 干净。

- [ ] **Step 4: 测试通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml consume_quota` → PASS;全量 `cargo test` 不回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/repository.rs src-tauri/src/proxy/handlers.rs
git commit -m "fix(stage3): quota 扣减原子化(带上限条件 UPDATE)"
```

---

### Task 4: SSE buffer 上限 + mid-stream 错误透传

**Files:**
- Modify: `src-tauri/src/proxy/handlers.rs:366-383`(stream map 闭包:buffer 限长 + Err arm)
- Test: `src-tauri/tests/stream_e2e.rs`

**Interfaces:**
- Consumes: 现有 `handle_stream`、`SseAccumulator`。
- Produces: 常量 `MAX_SSE_LINE_BYTES: usize = 1024 * 1024`(1MiB);buffer 超限时丢弃已累积字节并标记,防 OOM;Err arm 改发错误事件 chunk。

- [ ] **Step 1: 失败测试(buffer 上限)**

`stream_e2e.rs` 加:mock 上流发一条超长无换行 data(>1MiB)后跟正常 chunk,断言网关不挂、内存有界(直接断言能正常完成且下游收到后续 chunk)。同时加 mid-stream 错误测试:mock 在流中途断开/发错误,断言下游收到一个错误事件 chunk 而非静默空。

具体:
```rust
#[tokio::test]
async fn stream_oversize_line_does_not_hang() {
    // mock 发 >1MiB 单行 + 后续正常 SSE;断言 200 完成且后续 chunk 到达
}

#[tokio::test]
async fn stream_mid_error_emits_error_chunk() {
    // mock 流中途产生上游错误;断言下游 body 含错误事件标记(非纯空)
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test stream_e2e` → 这两个 FAIL。

- [ ] **Step 2: buffer 限长实现**

`handlers.rs` stream map 闭包:
```rust
const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
// Ok(bytes) 分支:
buffer.extend_from_slice(&bytes);
if buffer.iter().position(|&b| b == b'\n').is_none() && buffer.len() > MAX_SSE_LINE_BYTES {
    log::error!("SSE line exceeded {} bytes without newline; dropping", MAX_SSE_LINE_BYTES);
    buffer.clear();
}
while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
    let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
    let line = String::from_utf8_lossy(&line_bytes);
    acc.lock().feed_line(&line);
}
```

- [ ] **Step 3: mid-stream 错误透传**

Err arm 改发错误事件 chunk(OpenAI 风格 error JSON 行),而非空 Bytes:
```rust
Err(e) => {
    stream_error.store(true, Ordering::SeqCst);
    let err_chunk = format!("data: {{\"error\": {{\"message\": \"upstream stream error\"}}}}\n\n");
    Ok::<_, std::io::Error>(bytes::Bytes::from(err_chunk))
}
```
(保留 `stream_error` 标记,日志尾巴仍记 502 + 不消耗配额——不变。)

- [ ] **Step 4: 测试通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test stream_e2e` → PASS;全量 `cargo test` 不回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/proxy/handlers.rs src-tauri/tests/stream_e2e.rs
git commit -m "fix(stage3): SSE buffer 限长 + mid-stream 错误透传"
```

---

### Task 5: decide_action 加固(复位 blocked_reason + 未知 mode warn)

**Files:**
- Modify: `src-tauri/src/security/mod.rs:189-231`(`decide_action`)
- Test: `src-tauri/src/security/mod.rs` 测试模块

**Interfaces:**
- Consumes: 现有 `decide_action`/`SecurityScanResult`/`SecuritySettings`。
- Produces: 签名不变。行为:进入即复位 `blocked_reason=None`(仅 Block 时重设);未知 mode 回退 Allow 且 `log::warn!`。

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn decide_action_clears_stale_blocked_reason_on_non_block() {
    let mut r = SecurityScanResult { blocked_reason: Some("stale".into()), ..Default::default() };
    let s = SecuritySettings { mode: "audit".into(), ..Default::default() };
    decide_action(&mut r, &s);
    assert_eq!(r.action, SecurityAction::Allow);
    assert!(r.blocked_reason.is_none(), "stale blocked_reason 应被清除");
}

#[test]
fn decide_action_unknown_mode_falls_back_allow() {
    let mut r = SecurityScanResult::default();
    let s = SecuritySettings { mode: "bogus".into(), ..Default::default() };
    decide_action(&mut r, &s);
    assert_eq!(r.action, SecurityAction::Allow);
}
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml decide_action` → 第一个 FAIL(stale 未清)。

- [ ] **Step 2: 实现**

`decide_action` 开头(enabled 判断后)加复位 + match 的 `_` 臂加 warn:
```rust
pub fn decide_action(result: &mut SecurityScanResult, settings: &SecuritySettings) {
    result.blocked_reason = None;               // 复位,仅 Block 时重设
    if !settings.enabled {
        result.action = SecurityAction::Allow;
        return;
    }
    let rank = result.risk_level.rank();
    let mut action = match settings.mode.as_str() {
        // ... audit/warn/redact/block 臂不变 ...
        other => {
            log::warn!("unknown security mode {:?}, falling back to Allow", other);
            SecurityAction::Allow
        }
    };
    // block_on_critical 与 Block 时设 blocked_reason 逻辑不变
}
```

- [ ] **Step 3: 测试通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml decide_action` → PASS;全量 `cargo test` 不回归。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/security/mod.rs
git commit -m "fix(stage3): decide_action 复位 blocked_reason + 未知 mode warn"
```

---

### Task 6: 后端测试补强(failover / 边界 / rules.rs)

**Files:**
- Test: `src-tauri/tests/failover.rs`(新建,failover 分支)
- Test: `src-tauri/tests/quota_stream.rs` 或并入现有(quota/stats/stream 边界)
- Modify: `src-tauri/src/security/rules.rs` 测试模块(evidence 内容/大小写黑名单/append 语义)
- Modify: `src-tauri/tests/common/mod.rs`(死代码告警清理)

**Interfaces:**
- Consumes: `forwarder::forward`、`is_failover_status`(401/403/429/5xx)、`common::spawn_mock`、`Repository`。
- Produces: 仅测试,无生产签名变化。

- [ ] **Step 1: failover 分支测试**

`tests/failover.rs`:用两个 mock(主 channel 返回可 failover 状态,备 channel 返回 200),分别覆盖:
- 主 401 → 走备;主 403 → 走备;主 429 → 走备;主 500 → 走备。
- 主网络不可达(指向未监听端口)→ 走备。
- 全部候选失败 → 返回对应 5xx 且带 trace_id。
每个断言:备 channel 被命中、`record_channel_stats` 使主 success_rate 下降。
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test failover` → 先补到通过(当前行为已正确,这是补覆盖)。

- [ ] **Step 2: quota/stats/stream 边界测试**

- `consume_quota` 零值/大值/超额(复用 Task 3 的原子语义)。
- `record_channel_stats` 多次调用后 avg_latency_ms/success_rate 滑动正确。
- `stream=true` 走非流式 collect 路径(若存在该路径)返回完整响应。

- [ ] **Step 3: rules.rs 测试补全**

在 `rules.rs` 测试模块加:
```rust
#[test]
fn custom_blacklist_case_insensitive_and_evidence_masked() {
    let rules = vec![custom_rule("blacklist", "keyword", "Secret", "high")];
    let mut findings = vec![];
    apply_custom_rules("this has sEcReT inside", "request", "$.msg", &rules, &mut findings);
    assert_eq!(findings.len(), 1);
    let ev = findings[0].evidence_masked.as_ref().unwrap();
    assert!(ev.contains("****"), "evidence 应打码: {}", ev);
    assert!(!ev.contains("sEcReT inside"), "evidence 不应含原文");
}

#[test]
fn custom_rules_append_not_replace() {
    let rules = vec![custom_rule("blacklist", "keyword", "aaa", "high")];
    let mut findings = vec![existing_finding()];
    let before = findings.len();
    apply_custom_rules("aaa", "request", "$", &rules, &mut findings);
    assert_eq!(findings.len(), before + 1, "应 append 而非 replace");
}
```
(辅助 `custom_rule`/`existing_finding` 用测试模块内已有或新建。)

- [ ] **Step 4: 死代码告警清理**

`tests/common/mod.rs` 的 `MockUpstream` 未用字段/`spawn_mock` 未用告警:加 `#![allow(dead_code)]` 到 `common/mod.rs` 顶部(测试辅助本就按需使用),或删除确实未用字段。使 `cargo test` 无新增 warning。

- [ ] **Step 5: 全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿且无新增 warning。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tests/ src-tauri/src/security/rules.rs
git commit -m "test(stage3): failover 分支 + quota/stats/stream 边界 + rules.rs 补全"
```

---

### Task 7: 前端 UX 与测试深化

**Files:**
- Modify: `src/pages/ChannelsPage.tsx`、`ApiKeysPage.tsx`、`RoleRoutesPage.tsx`、`SecurityPage.tsx`、`LogsPage.tsx`(error 成功即清除 + 输入校验)
- Modify: `src/pages/SecurityPage.tsx`(重置默认确认弹窗)
- Test: `src/pages/__tests__/RoleRoutesPage.test.tsx`(断言实际调用)
- Test: `src/pages/__tests__/SecurityPage.test.tsx`(重置确认 + error 清除,如需要)

**Interfaces:**
- Consumes: 现有各页 `handleError`/`load()` 模式、`api.*`。
- Produces: 无新 api;UX 行为:操作成功清空 error;重置默认需确认;数值输入校验。

- [ ] **Step 1: error 成功即清除**

各页在成功的 `load()`/操作回调里 `setError(null)`。统一改法(以 RoleRoutesPage 为例,`handleError` 已有):
```tsx
const load = () => {
  setError(null);                       // 成功路径前清除旧错误
  api.listRoleRoutes().then(setRoutes).catch(handleError);
  // ...
};
```
对 5 个页逐一加(Channels/ApiKeys/RoleRoutes/Security/Logs)。

- [ ] **Step 2: 重置默认确认弹窗**

`SecurityPage.tsx` `resetBuiltin`:
```tsx
const resetBuiltin = () => {
  if (!window.confirm("确定重置全部内置规则为默认?自定义启停/级别将丢失。")) return;
  api.resetBuiltinSecurityRules().then(load).catch(handleError);
};
```

- [ ] **Step 3: 数值输入校验**

quota 等数值输入:解析失败/NaN/负数时不提交并提示(如 ApiKeysPage 的 quota 输入)。统一:
```tsx
const n = Number(value);
if (!Number.isFinite(n) || n < 0) { setError("请输入非负数字"); return; }
```

- [ ] **Step 4: RoleRoutesPage 测试断言实际调用**

`RoleRoutesPage.test.tsx` 加一个用例:改渠道 select 触发 `setRoleRoute`,清空触发 `deleteRoleRoute`:
```tsx
it("切换角色渠道调用 setRoleRoute/deleteRoleRoute", async () => {
  render(<RoleRoutesPage />);
  await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());
  const select = screen.getAllByRole("combobox")[0];   // sonnet 行渠道下拉
  fireEvent.change(select, { target: { value: "c1" } });
  await waitFor(() => expect(api.setRoleRoute).toHaveBeenCalledWith("sonnet", "c1", expect.any(String)));
  fireEvent.change(select, { target: { value: "" } });
  await waitFor(() => expect(api.deleteRoleRoute).toHaveBeenCalledWith("sonnet"));
});
```
(import `fireEvent`。)

- [ ] **Step 5: 验证**

Run: `pnpm test:unit` → PASS;`pnpm typecheck` → PASS。

- [ ] **Step 6: Commit**

```bash
git add src/pages/
git commit -m "feat(stage3): 前端 error 清除 + 重置确认 + 输入校验 + 测试深化"
```

---

## Self-Review 记录

- **Spec 覆盖**:A 类=Task 1(parking_lot)+Task 2(吞错误);B 类=Task 3(quota)+Task 4(SSE/mid-stream)+Task 5(decide_action);C 类=Task 6;D 类=Task 7。spec §6 验证/执行与 §7 非目标体现在 Global Constraints。
- **Placeholder 扫描**:Task 6 Step 1 的 failover 测试未给完整 mock 接线代码(只列场景),实现者需照 `tests/common` 模式补——已在 Step 注明「照 tests/common 模式」;其余代码步骤均含完整代码。`custom_rule`/`existing_finding`/`api_key_fixture` 等辅助名称标注了「用现有/实际辅助」,因各测试模块辅助名以实际为准。
- **类型一致性**:`consume_quota` 改返回 `AppResult<bool>`(Task 3 Produces + Step 2/3 一致);`Db::conn`/`AppState` parking_lot 类型(Task 1 Produces 一致);`MAX_SSE_LINE_BYTES`(Task 4 一致);decide_action 签名不变(Task 5 一致)。
- **顺序依赖**:Task 1 先行(锁迁移是所有后续的基础);Task 2/3 依赖 Task 1;Task 4-7 相对独立,可并行但都应在 Task 1 之后(共享 handlers.rs)。
