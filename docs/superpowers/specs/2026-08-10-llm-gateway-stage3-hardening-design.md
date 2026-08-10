# Stage 3 · 完善与加固 — 设计

**日期:** 2026-08-10
**分支:** `feat/stage3-hardening`
**前置:** Stage 1 核心网关、Stage 2 安全审计中心均已合并 master(HEAD `3a55947`)。

## 1. 目标与范围

不引入任何新特性。针对 Stage 1 / Stage 2 两阶段累积的 deferred / ACCEPT 项,做四个维度的加固:健壮性(锁与错误处理)、正确性边界、测试覆盖、前端 UX。所有改动以「不破坏现有安全不变量」为前提。

**安全不变量(不得回归):**
- 真实上游 `channels.api_key` 永不泄露(不进前端/日志/错误/响应,仅转发时注入 header;前端只见 masked `sk-***<last4>`)。
- 阻断发生在转发上游之前(请求侧 451 在 forwarder 调用前;响应侧 451 替换上游内容)。
- 两信任边界脱敏解耦:转发按 `enabled && redact_secrets` 门控;落库 `redact_json_for_logging` 无条件(request_body/response_body、流式/非流式)。
- Escalate-only 风险合并(level/score 取 max,action Block>Redact>Warn>Allow,不降低请求侧)。
- findings 按 phase 入库且关联正确 log_id;流式 chunk 逐字节不改。

## 2. A 类 · 锁与错误处理(parking_lot 迁移)

**决策:迁移到 `parking_lot`,从根上消除 `Mutex` poison 与 `.unwrap()`。**

- `src-tauri/Cargo.toml` 增加 `parking_lot` 依赖。
- `Db.conn: Arc<std::sync::Mutex<Connection>>` → `Arc<parking_lot::Mutex<Connection>>`;`Db::conn()` 返回类型同步改。
- `AppState.fallback: Arc<RwLock<Option<(String,String)>>>`、`AppState.security: Arc<RwLock<SecuritySettings>>` → `parking_lot::RwLock`。
- parking_lot 的 `lock()/read()/write()` 直接返回 guard(不返回 `Result`),删除全部约 57 处 `lock().unwrap()` / `read().unwrap()` / `write().unwrap()`。编译器驱动改完所有调用点(主要在 `db/mod.rs`、`proxy/state.rs`、`proxy/handlers.rs`、`proxy/security_hook.rs`、`commands/*.rs`)。
- 统一吞错误:残留的 `let _ = repo.consume_quota(...)` / `let _ = repo.insert_log(...)` / 部分 `let _ = write_log(...)` 改为 `if let Err(e) = ... { log::error!(...) }`;tauri-store 读写错误(`set_fallback` / `set_security_setting`)同样记录。

**验收:** 全代码库不再出现 `lock().unwrap()`/`read().unwrap()`/`write().unwrap()`;`cargo build` 无 poison 相关残留;`cargo test` 全绿。

## 3. B 类 · 正确性边界

1. **quota 原子化**:`consume_quota` 的 check-then-consume 合并为一条带条件 UPDATE:
   `UPDATE api_keys SET quota_used=quota_used+?1 WHERE id=?2 AND (quota_total IS NULL OR quota_used+?1<=quota_total)`,依据受影响行数判断是否超配,消除 check 与 consume 之间的竞态。
2. **SSE line buffer 上限**:`handle_stream` 的字节 buffer 加上限(1MiB);无换行且超限时截断/丢弃,防内存无限增长。
3. **mid-stream 错误透传**:`forward_stream` 的上游错误不再静默发空 `Bytes`,改发一个错误事件 chunk(如 `data: {"error": ...}` 或对应协议错误帧),让下游调用方能感知失败;日志尾巴逻辑保持(仍记 502 + 不消耗配额)。
4. **decide_action 加固**:每次决策前复位 stale `blocked_reason`;未知 mode 回退 Allow 时记 `log::warn!`(不静默)。

**验收:** 每项配回归测试(quota 超额拒绝、buffer 上限不 OOM、mid-stream 错误 chunk 可达、未知 mode 有 warn)。

## 4. C 类 · 后端测试补强

- **failover 分支全覆盖**:正常路径、网络错误、超时、401、403、429、5xx 各自的 failover/重试行为集成测试(forwarder)。
- **quota/stats/stream 边界**:record_channel_stats 覆盖;consume_quota 边界(超额/零/大值);`stream=true` 非流式 collect 路径。
- **rules.rs 测试缺口**:assert `evidence_masked` 实际内容、大小写不敏感黑名单、append-not-replace 语义。
- **死代码告警清理**:`spawn_mock`/`MockUpstream` 等测试辅助的死代码告警(加 `#[allow(dead_code)]` 或精简字段),使 `cargo build`/`cargo test` 无新增 warning。

## 5. D 类 · 前端 UX 与测试

- **error 状态成功即清除**:各页(Channels/ApiKeys/RoleRoutes/Security/Logs)操作成功后清空 error banner(当前残留到下次出错或刷新)。
- **重置默认确认弹窗**:SecurityPage「重置默认」加确认,防误触。
- **输入校验/NaN 防护**:quota 等数值输入补齐校验。
- **前端测试深化**:RoleRoutesPage 测试由仅断言 render 补为断言 `setRoleRoute`/`deleteRoleRoute` 实际被调用。

## 6. 验证与执行

- 每个任务:`cargo test`、`pnpm test:unit`、`pnpm typecheck` 全绿。
- 全程不得引入安全不变量回归;A/B 类改动后需复核密钥隔离与脱敏边界。
- **执行方式**:沿用 SDD(subagent-driven development):按 A→B→C→D 拆任务,每任务 subagent 实现 → 评审(SPEC/QUALITY)→ fix 循环 → 全部完成后最终全分支评审(Opus),最后 fast-forward 合并 master。

## 7. 非目标(YAGNI)

- 不引入新功能/新页面/新协议适配。
- 不做与本次加固无关的大规模重构。
- 不改变既有已 ACCEPT 的行为语义(如 int latency 截断、whitelist 类别范围、本地单操作员假设),除非上方明确列出。
