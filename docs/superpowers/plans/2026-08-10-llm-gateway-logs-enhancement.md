# 日志审计增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有日志系统上增量增强——结构化筛选(filter bar 联动)、统计卡片 + canvas 时间趋势图、日志清理(手动 + 自动保留),不新增页面、不引入新运行时依赖。

**Architecture:** 沿用三层(React LogsPage → Tauri 命令层 → repository / SQLite 单连接 parking_lot Mutex)。后端 `repository.rs` 新增领域 `LogFilter` + `build_where` 共用 WHERE 生成器,`list_logs`/`count_logs`/`log_stats`/`log_timeseries`/`delete_logs_before`/`clear_logs` 复用它保证筛选/统计/趋势一致;命令层 `commands/log.rs` 扩展(复用现有雏形);前端 LogsPage 顶部内嵌统计卡片 + `LogTrendChart`(canvas 2D 自绘)+ filter bar + 清理 UI。

**Tech Stack:** Rust (Tauri 2 / axum / rusqlite / parking_lot)、React + TypeScript + vitest(jsdom)、Tailwind、canvas 2D(零依赖)。

## Global Constraints

- 安全不变量不得回归:真实 `channels.api_key` 永不泄露;统计/趋势只读聚合数字,**绝不返回** `request_body`/`response_body` 原文;落库数据已无条件脱敏(`redact_json_for_logging`)。
- 不新增页面、不引入图表库或其他运行时依赖(canvas 自绘)。不改变 `request_logs`/`request_security_findings` 表结构(仅加索引)。
- 复用现有件,不重复:`idx_logs_risk_level` 已存在(002_security.sql);`commands/stats.rs get_stats`/`repo.stats()` 已存在(前端增强复用,后端不重复);`commands/log.rs` 已有 `LogFilter`/`LogPage` 雏形(在此基础上扩展)。
- 清理级联:`request_security_findings.log_id` 无 ON DELETE CASCADE → 删除走事务显式先删 findings 再删 logs,不留孤儿。
- 锁:生产代码一律 parking_lot guard 直接 `.lock()`(无 `.unwrap()`);测试 mock 内 std Mutex 除外。
- 每任务验收:`cargo test --manifest-path src-tauri/Cargo.toml`、`pnpm test:unit`、`pnpm typecheck` 全绿,0 新 warning;改动前端时 `pnpm build` 通过。
- 提交前缀 `feat(logs):` / `test(logs):` / `fix(logs):`。
- 分支:`feat/logs-enhancement`,从 master(含 spec commit `40f131f`)切出。

---

### Task 1: 迁移 003_logs.sql(筛选/聚合索引)

**Files:**
- Create: `src-tauri/migrations/003_logs.sql`
- Modify: `src-tauri/src/db/mod.rs:10-13`(`MIGRATIONS` 数组注册)

**Interfaces:**
- Consumes: 现有 `migrate()` 版本表机制(001/002)。
- Produces: 索引 `idx_logs_status`/`idx_logs_api_key`/`idx_logs_channel`(`idx_logs_risk_level`/`idx_logs_created`/`idx_logs_trace` 已存在,不重复)。

- [ ] **Step 1: 写迁移 SQL**

`src-tauri/migrations/003_logs.sql`:
```sql
CREATE INDEX IF NOT EXISTS idx_logs_status   ON request_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_logs_api_key  ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_logs_channel  ON request_logs(channel_id);
```

- [ ] **Step 2: 注册迁移**

`src-tauri/src/db/mod.rs` `MIGRATIONS`:
```rust
const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/001_init.sql"),
    include_str!("../../migrations/002_security.sql"),
    include_str!("../../migrations/003_logs.sql"),
];
```

- [ ] **Step 3: 测试 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿(迁移对既有内存/集成测试幂等)。
```bash
git add src-tauri/migrations/003_logs.sql src-tauri/src/db/mod.rs
git commit -m "feat(logs): 003_logs 迁移(筛选/聚合索引)"
```

---

### Task 2: 领域 LogFilter + build_where + list_logs/count_logs 重构

**Files:**
- Modify: `src-tauri/src/db/repository.rs`(`LogFilter`/`StatusClass`/`build_where`;重构 `list_logs:334`/`count_logs:323`;`#[cfg(test)]` 单测)
- Modify: `src-tauri/src/commands/log.rs`(`CommandLogFilter` + 映射;`list_logs` 透传)

**Interfaces:**
- Consumes: Task 1 索引。
- Produces:
  - `pub struct LogFilter { keyword, api_key_id, channel_id, role, risk_level: Option<String>, status: Option<StatusClass>, is_stream: Option<bool>, after, before: Option<i64> }`
  - `pub enum StatusClass { Success, ClientError, ServerError }` → `fn range(&self) -> (i64, i64)` = (200,299)/(400,499)/(500,599)
  - `fn build_where(filter: &LogFilter) -> (String, Vec<rusqlite::types::Value>)` — 私有,返回 `WHERE ...` 子句 + 按序绑定值。
  - `list_logs(&self, filter: &LogFilter, limit: i64, offset: i64) -> AppResult<Vec<RequestLog>>`
  - `count_logs(&self, filter: &LogFilter) -> AppResult<i64>`
  - 命令层:`CommandLogFilter { keyword, api_key_id, channel_id, role, risk_level, status: Option<String>("2xx"/"4xx"/"5xx"), is_stream, after, before, limit, offset }`,`fn to_filter(&self) -> LogFilter`(status 字符串映射枚举,未知值忽略为 None)。

**关键实现点:**
- `build_where` 动态拼接,每个 Some 字段一条 `AND ...`,绑定值按追加顺序 push。keyword 保留现有 OR 模糊:`(request_model LIKE ? OR upstream_model LIKE ? OR trace_id LIKE ? OR channel_name LIKE ? OR key_name LIKE ?)`。status → `status_code BETWEEN ? AND ?`。after/before → `created_at >= ?` / `created_at <= ?`。is_stream → `is_stream = ?`(1/0)。空 filter → `WHERE 1=1`。
- 统一用 `conn.prepare(&format!("... {} ORDER BY seq DESC LIMIT ? OFFSET ?", where_sql))` + `stmt.query_map(rusqlite::params_from_iter(values.iter().chain([limit.into(), offset.into()].iter())), ...)`;`count_logs` 用 `SELECT COUNT(*) ... {where_sql}`。
- 保持 28 列映射与 keyword 行为不变(向后兼容现有调用)。

- [ ] **Step 1: 失败测试**

`repository.rs` `#[cfg(test)]` 加(用内存 DB 造多条不同 status/risk/channel/created_at 的 `RequestLog`,`insert_log` 插入):
```rust
#[test]
fn list_logs_filter_multi_condition_and() { /* 组合 channel_id+risk_level+status,断言仅匹配子集且 count_logs 一致 */ }
#[test]
fn list_logs_filter_date_range_and_status_class() { /* after/before + status=ServerError,断言边界与分类 */ }
#[test]
fn list_logs_keyword_backward_compatible() { /* 仅 keyword,行为同旧 */ }
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml list_logs_filter` → FAIL(当前无结构化筛选)。

- [ ] **Step 2: 实现 LogFilter/build_where + 重构**

按上方 Interfaces/关键点实现。`commands/log.rs` `CommandLogFilter` 扩展字段 + `to_filter`,`list_logs` 改调 `repo.list_logs(&filter, limit, offset)` + `repo.count_logs(&filter)`。

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿(含旧 keyword 路径不回归)。
```bash
git add src-tauri/src/db/repository.rs src-tauri/src/commands/log.rs
git commit -m "feat(logs): 结构化 LogFilter + build_where,list_logs/count_logs 重构"
```

---

### Task 3: log_stats 聚合查询

**Files:**
- Modify: `src-tauri/src/db/repository.rs`(`log_stats` + `LogStats` 结构;单测)

**Interfaces:**
- Consumes: Task 2 `build_where`/`LogFilter`。
- Produces:
  ```rust
  pub struct LogStats {
      pub total_calls: i64,
      pub total_input_tokens: i64,
      pub total_output_tokens: i64,
      pub success_count: i64,          // status 2xx 计数(成功率 = success_count/total_calls 前端算)
      pub risk_distribution: Vec<(String, i64)>,   // (risk_level, count)
      pub top_channels: Vec<(String, i64)>,        // (channel_name, count) Top5
      pub top_api_keys: Vec<(String, i64)>,        // (key_name, count) Top5
  }
  pub fn log_stats(&self, filter: &LogFilter) -> AppResult<LogStats>
  ```
- 复用 `build_where`;`risk_distribution` `GROUP BY risk_level`;TopN `GROUP BY channel_name/key_name ORDER BY COUNT(*) DESC LIMIT 5`。

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn log_stats_aggregates_correctly() { /* 造数据:断言 total_calls/tokens/success_count/risk_distribution/top_channels 数值 */ }
#[test]
fn log_stats_respects_filter() { /* 加 channel_id 筛选,断言仅统计该渠道 */ }
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml log_stats` → FAIL。

- [ ] **Step 2: 实现 log_stats**

按上 SQL 思路实现(单条聚合 + 两个 GROUP BY 子查询,均走同一 `build_where`)。

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml log_stats` → PASS。
```bash
git add src-tauri/src/db/repository.rs
git commit -m "feat(logs): log_stats 聚合(总数/token/成功率/风险分布/TopN)"
```

---

### Task 4: log_timeseries 分桶查询

**Files:**
- Modify: `src-tauri/src/db/repository.rs`(`log_timeseries` + `TimeBucket`;单测)

**Interfaces:**
- Consumes: Task 2 `build_where`/`LogFilter`。
- Produces:
  ```rust
  pub struct TimeBucket {
      pub bucket: i64,           // (created_at/bucket_secs)*bucket_secs
      pub calls: i64,
      pub input_tokens: i64,
      pub output_tokens: i64,
      pub error_count: i64,      // 非 2xx 计数
      pub risk_counts: std::collections::BTreeMap<String, i64>, // 每 risk_level 计数
  }
  pub fn log_timeseries(&self, filter: &LogFilter, bucket_secs: i64) -> AppResult<Vec<TimeBucket>>
  ```
- SQL:`SELECT (created_at/?b)*?b AS bucket, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(CASE WHEN status_code NOT BETWEEN 200 AND 299 THEN 1 ELSE 0 END), SUM(CASE WHEN risk_level='clean' THEN 1 ELSE 0 END), ...(6 个 risk_level 各一列)... FROM request_logs {where} GROUP BY bucket ORDER BY bucket ASC`。bucket_secs 作为绑定参数;buckets 只含非空桶(空桶由前端补 0)。

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn log_timeseries_buckets_correctly() { /* 造跨桶/同桶数据,断言分桶、各 risk_counts、error_count */ }
#[test]
fn log_timeseries_empty_when_no_match() { /* 无匹配 filter → 空 vec */ }
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml log_timeseries` → FAIL。

- [ ] **Step 2: 实现 log_timeseries**

按上 SQL;risk_level 列固定枚举 clean/info/low/medium/high/critical,读列填 `risk_counts`。

- [ ] **Step 3: 测试通过 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml log_timeseries` → PASS。
```bash
git add src-tauri/src/db/repository.rs
git commit -m "feat(logs): log_timeseries 时间分桶(调用/token/错误/风险计数)"
```

---

### Task 5: 日志清理(事务级联)+ 保留天数

**Files:**
- Modify: `src-tauri/src/db/repository.rs`(`delete_logs_before`/`clear_logs`;单测)
- Modify: `src-tauri/src/commands/log.rs`(`delete_logs_before`/`clear_logs`/`set_log_retention_days`/`get_log_retention_days` 命令)
- Modify: `src-tauri/src/lib.rs`(启动时保留清理,挂在 `apply_settings` 之后、`app.manage` 之前)
- 单测:`repository.rs` 清理事务;store 读写参照 `security.rs` 模式

**Interfaces:**
- Consumes: Task 2 起;`request_security_findings.log_id` 外键。
- Produces:
  - `pub fn delete_logs_before(&self, ts: i64) -> AppResult<usize>` — 事务内先 `DELETE FROM request_security_findings WHERE log_id IN (SELECT id FROM request_logs WHERE created_at < ?1)` 再 `DELETE FROM request_logs WHERE created_at < ?1`,commit,返回删除日志行数。**边界:`created_at < ts`(严格小于,删「早于该日」)。**
  - `pub fn clear_logs(&self) -> AppResult<usize>` — 同上但条件恒真(清两表全部)。
  - 命令:`delete_logs_before(before: i64) -> Result<usize,String>`、`clear_logs() -> Result<usize,String>`、`set_log_retention_days(app, days: i64) -> Result<(),String>`(校验 days>=0,store.set("log_retention_days")+save)、`get_log_retention_days(app) -> Result<i64,String>`(store.get,缺省 0)。
- 启动清理(lib.rs):`if let Ok(store)=app.store("store.bin") { if let Some(d)=store.get("log_retention_days").and_then(as_i64) { if d>0 { let cutoff=now-d*86400; if let Err(e)=state.repo.delete_logs_before(cutoff) { log::error!("log retention cleanup failed: {}",e); } } } }` — 失败仅 log 不阻断。

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn delete_logs_before_cascades_findings() { /* 造 log+finding,删后断言两表相关行均删、无孤儿,返回行数正确 */ }
#[test]
fn delete_logs_before_boundary_exclusive() { /* created_at == ts 的行保留(严格小于) */ }
#[test]
fn clear_logs_empties_both_tables() { /* 两表清空,返回日志行数 */ }
```
Run: `cargo test --manifest-path src-tauri/Cargo.toml delete_logs` → FAIL。

- [ ] **Step 2: 实现 repository 清理 + 命令 + lib.rs 启动清理**

按上;`conn.transaction()` 模式;命令层薄封装 + store 持久化(参照 `commands/security.rs set_security_setting` 的 store.set/save 模式);lib.rs 启动清理挂到 fallback/security 加载之后。

- [ ] **Step 3: 注册命令 + 测试通过 + 提交**

`lib.rs` `generate_handler!` 注册 4 个新命令。
Run: `cargo test --manifest-path src-tauri/Cargo.toml delete_logs` → PASS;全量不回归。
```bash
git add src-tauri/src/db/repository.rs src-tauri/src/commands/log.rs src-tauri/src/lib.rs
git commit -m "feat(logs): 日志清理事务级联 + 保留天数(启动时清理)"
```

---

### Task 6: 命令层统计/趋势 + 前端 api wrapper + TS 类型

**Files:**
- Modify: `src-tauri/src/commands/log.rs`(`get_log_stats`/`get_log_timeseries` 命令;序列化结构)
- Modify: `src-tauri/src/lib.rs`(`generate_handler!` 注册)
- Modify: `src/types/index.ts`(`LogFilter`/`LogStats`/`TimeBucket`/`StatusClass` 类型)
- Modify: `src/lib/api.ts`(wrapper 更新 + 新增)

**Interfaces:**
- Consumes: Task 2-5 后端。
- Produces:
  - 命令:`get_log_stats(filter: CommandLogFilter) -> Result<LogStats,String>`;`get_log_timeseries(filter: CommandLogFilter, bucket: i64) -> Result<Vec<TimeBucket>,String>`(`bucket` 由前端按跨度算:≤48h→3600,否则→86400)。
  - TS:`type StatusClass = "2xx"|"4xx"|"5xx"`;`interface LogFilter { keyword?, api_key_id?, channel_id?, role?, risk_level?, status?: StatusClass, is_stream?, after?, before?, limit?, offset? }`;`interface LogStats {...}`;`interface TimeBucket { bucket, calls, input_tokens, output_tokens, error_count, risk_counts: Record<string,number> }`。
  - api.ts:`listLogs(filter: LogFilter)`(改签名,透传整个 filter)、`getLogStats(filter)`、`getLogTimeseries(filter, bucket)`、`deleteLogsBefore(before)`、`clearLogs()`、`getLogRetentionDays()`、`setLogRetentionDays(days)`。注意 snake_case 参数名。

- [ ] **Step 1: 命令 + 注册**

`commands/log.rs` 加 `get_log_stats`/`get_log_timeseries`;`lib.rs` 注册全部新命令(list_logs 已注册)。
Run: `cargo build --manifest-path src-tauri/Cargo.toml` → 干净。

- [ ] **Step 2: TS 类型 + api wrapper**

按上更新 `types/index.ts` 与 `api.ts`(`listLogs` 改签名——LogsPage 在 Task 8 适配,此处先把类型/ wrapper 备好)。
Run: `pnpm typecheck` → 通过(LogsPage 暂存编译错误由 Task 8 修;若需先行可让 listLogs 兼容两签名——见 Self-Review 注)。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/commands/log.rs src-tauri/src/lib.rs src/types/index.ts src/lib/api.ts
git commit -m "feat(logs): 统计/趋势命令 + 前端 api wrapper 与 TS 类型"
```

---

### Task 7: LogTrendChart canvas 组件(纯函数 + 组件 + 单测)

**Files:**
- Create: `src/components/LogTrendChart.tsx`
- Create: `src/components/__tests__/LogTrendChart.test.tsx`

**Interfaces:**
- Consumes: Task 6 `TimeBucket` 类型。
- Produces:
  - `export type Dimension = "calls" | "tokens" | "success" | "risk";`
  - 纯函数(导出供单测):`computeTicks(buckets) -> { xLabels: {i,label}[], yMax: number }`、`niceCeil(n: number) -> number`(Y 轴上限规整)、`stackSums(b: TimeBucket) -> number`(各 risk 计数求和)、`formatBucketLabel(bucketSecs, ts) -> string`(小时桶 `MM-DD HH:00`,天桶 `MM-DD`)。
  - 组件 `LogTrendChart({ buckets, dimension }: { buckets: TimeBucket[]; dimension: Dimension })`:canvas 2D 自绘,4 维度不同画法。

**关键实现点:**
- 尺寸:容器宽自适应(`ref` + `ResizeObserver` 或固定父宽),`devicePixelRatio` 缩放,高 ~180px。
- 画法:calls=柱状;tokens=双折线(input/output)+图例;success=成功率折线(每桶 `(calls-error_count)/calls`,0–100% 轴);risk=堆叠柱状(clean灰/info蓝/low绿/medium黄/high橙/critical红,与 LogsPage 一致)。
- tooltip:mousemove 命中最近桶 → div 绝对定位显示该桶数值。
- 空态:`buckets.length===0` 显示「暂无数据」;单桶退化防除零(成功率分母 max(calls,1))。
- **jsdom 兼容:** canvas 渲染包 `try/catch`(`getContext` 在 jsdom 返回 null),纯函数独立于 canvas 可测。

- [ ] **Step 1: 失败测试(纯函数 + 组件渲染)**

```tsx
// 纯函数
it("niceCeil 规整 Y 上限", () => { expect(niceCeil(0)).toBe(1); expect(niceCeil(7)).toBe(10); });
it("computeTicks 稀疏取刻度", () => { /* 多桶 → 刻度 ~6,label 格式正确 */ });
it("stackSums 求和各 risk", () => { /* risk_counts 求和 */ });
// 组件
it("renders without crashing and shows empty state", () => { render(<LogTrendChart buckets={[]} dimension="calls" />); expect(screen.getByText("暂无数据")).toBeInTheDocument(); });
it("renders canvas when buckets present", () => { const { container } = render(<LogTrendChart buckets={[b]} dimension="calls" />); expect(container.querySelector("canvas")).toBeInTheDocument(); });
```
Run: `pnpm test:unit LogTrendChart` → FAIL(组件不存在)。

- [ ] **Step 2: 实现 LogTrendChart**

按上;纯函数与组件分离,canvas 绘制在 `useEffect` 内。

- [ ] **Step 3: 测试通过 + 提交**

Run: `pnpm test:unit` + `pnpm typecheck` → 绿。
```bash
git add src/components/
git commit -m "feat(logs): LogTrendChart canvas 趋势组件(4 维度自绘)"
```

---

### Task 8: LogsPage 集成(filter bar + 统计卡片 + 趋势面板 + 清理 UI)+ 单测

**Files:**
- Modify: `src/pages/LogsPage.tsx`(集成全部)
- Create: `src/pages/__tests__/LogsPage.test.tsx`

**Interfaces:**
- Consumes: Task 6 api wrapper + Task 7 LogTrendChart + 现有 LogsPage 结构。
- Produces: LogsPage 顶部内嵌「filter bar + 统计卡片 + 维度 tab 趋势面板」+ 列表 + 清理区。

**关键实现点:**
- **状态**:`filter` 对象(替代单一 keyword state)、`stats: LogStats | null`、`buckets: TimeBucket[]`、`dimension: Dimension`。
- **filter bar**:keyword 输入 + 渠道下拉(`api.listChannels`)+ 密钥下拉(`api.listApiKeys`,显示 name)+ 角色下拉(sonnet/opus/fable/haiku)+ 风险下拉(6 级)+ 状态下拉(2xx/4xx/5xx)+ 流式下拉(全部/流式/非流式)+ 日期起止(`<input type="date">`,转秒级 after/before)。「查询」按钮 → `setPage(0)` + 触发 `loadAll()`。
- **联动**:`loadAll()` 同时调 `api.listLogs(filter+limit/offset)`、`api.getLogStats(filter)`、`api.getLogTimeseries(filter, bucket)`(bucket 按 after..before 跨度:≤48h→3600 否则 86400);三者 `.catch(handleError`;成功路径 `setError(null)`(承袭 Stage 3)。page 变化仅重拉 `listLogs`(统计/趋势不随分页变)。
- **统计卡片**:总调用、总 Token(input+output)、成功率(success_count/total_calls)、各 risk 计数徽标、Top 渠道/密钥(名称+次数,小列表)。
- **趋势面板**:4 个 tab(调用量/Token/成功率/风险分布)切 `dimension`,渲染 `<LogTrendChart buckets dimension />`。
- **清理区**:日期选择 +「删除该日之前」(确认框,文案含「不可恢复」+ 级联 findings)+「清空全部」(二次确认)+ 保留天数输入(非负校验,`setLogRetentionDays`)+ 显示当前保留天数(`getLogRetentionDays`)。删除后 `loadAll()` 刷新。
- **保留既有**:28 行表格、展开行 findings、分页、error banner、Stage 3 error 清除。

- [ ] **Step 1: 失败测试(LogsPage)**

```tsx
it("filter bar 变更触发 listLogs/getLogStats/getLogTimeseries 联动", async () => { /* 点查询 → 断言三 api 被调且 filter 参数正确 */ });
it("统计卡片渲染聚合数据", async () => { /* mock getLogStats → 断言总调用/token 文案 */ });
it("趋势面板 4 tab 切换 dimension", async () => { /* 点 tab → 断言 LogTrendChart 收到不同 dimension(或 dimension state 变化) */ });
it("删除该日之前需确认并调 deleteLogsBefore", async () => { /* window.confirm mock true → 点删除 → 断言 api.deleteLogsBefore 被调 + loadAll 刷新 */ });
it("保留天数输入非负校验", async () => { /* 输入 -1 → 提示错误,不调 api */ });
```
(mock `api.*` + `window.confirm`;参照 `SecurityPage.test.tsx` 的 vi.mock 模式。)
Run: `pnpm test:unit LogsPage` → FAIL。

- [ ] **Step 2: 实现 LogsPage 集成**

按上;保持既有表格/展开/分页逻辑不变,新增顶部区与清理区。

- [ ] **Step 3: 测试通过 + 提交**

Run: `pnpm test:unit` + `pnpm typecheck` + `pnpm build` → 绿。
```bash
git add src/pages/
git commit -m "feat(logs): LogsPage filter bar + 统计卡片 + 趋势面板 + 清理 UI"
```

---

### Task 9: 端到端集成测试(经真实网关造数据)+ 安全回归 grep

**Files:**
- Create: `src-tauri/tests/logs_enhanced.rs`
- (可选)Modify: `src-tauri/tests/security_request.rs`、`security_response.rs`(若发现是死文件则删除——见下)

**Interfaces:**
- Consumes: 全部后端任务;`tests/common::spawn_mock`;`proxy::server::start`;`handlers::openai_chat`(`/v1/chat/completions`)。
- Produces: 经真实 HTTP 网关产生日志行后,直接调 `repo.list_logs/log_stats/log_timeseries/delete_logs_before/clear_logs` 断言端到端。

**关键实现点:**
- 参照 `stream_e2e.rs`/`failover.rs` 模式:`spawn_mock` 起 mock 上游 → 造 channel/api_key → `server::start` 起网关 → reqwest POST `/v1/chat/completions`(带合法/非法密钥、触发不同 status/risk)产生日志 → 用 `state.repo` 直接断言。
- 覆盖:多条件筛选端到端;`log_stats` 反映真实请求;`delete_logs_before` 级联 findings(造带风险请求产生 finding);`clear_logs` 清空。
- **死文件排查**:确认 `security_request.rs`/`security_response.rs` 是否仍被引用(`/v1/security/*` 端点不存在于 server.rs)。若为死测试文件,在本任务删除并在报告中说明(若其实测试 `/v1/chat/completions` 安全行为则保留)。**实现者需先读这两个文件判断,勿盲目删。**
- 安全回归:`grep -rn "request_body\|response_body" src-tauri/src/commands/log.rs`(统计/趋势/清理命令不得返回 body 原文);`grep -rn "api_key" src-tauri/src/commands/log.rs`(不得触碰 channels.api_key)。

- [ ] **Step 1: 失败/新集成测试**

按上写 `logs_enhanced.rs` 用例(可先跑确认新断言基于新 API)。
Run: `cargo test --manifest-path src-tauri/Cargo.toml --test logs_enhanced` → 视实现进度先 FAIL 后 PASS。

- [ ] **Step 2: 死文件处理 + 安全 grep**

读 `security_request.rs`/`security_response.rs` 判定;执行 grep 并确认无泄漏。

- [ ] **Step 3: 全量测试 + 提交**

Run: `cargo test --manifest-path src-tauri/Cargo.toml` → 全绿,0 新 warning。
```bash
git add src-tauri/tests/
git commit -m "test(logs): 日志增强端到端集成测试 + 安全回归"
```

---

## Self-Review 记录

- **Spec 覆盖**:§3 筛选+聚合→Task 2/3/4;§4 趋势组件→Task 7;§5 清理+保留→Task 5;§2 命令/api/前端集成→Task 6/8;§6 测试/验证/安全回归→各任务 Step + Task 9。§1 安全不变量→Global Constraints + Task 9 grep。
- **Placeholder 扫描**:Task 3/4 聚合 SQL 给了思路与列结构(完整字段名/枚举值已列),具体 SELECT 字符串由实现者按 `build_where` 模式拼(已在 Task 2 给出完整拼接规则);canvas 绘制逐像素代码未全列(纯函数与画法规则已给,属实现自由度)。其余步骤含完整代码或精确签名。
- **类型一致性**:领域 `LogFilter`(Task 2)与 `CommandLogFilter`(Task 2/6)字段一致(status 领域枚举 ↔ 命令字符串,映射在 `to_filter`);`TimeBucket.risk_counts` Rust `BTreeMap<String,i64>` ↔ TS `Record<string,number>`;`listLogs` TS 签名(Task 6)与 LogsPage 调用(Task 8)一致;`idx_logs_risk_level` 不重复(002 已有);`get_stats`/`repo.stats()` 不重复(前端复用,后端 log_stats 为新增聚合,职责不同——stats 是全局概览,log_stats 是筛选子集聚合)。
- **顺序依赖**:Task 1(索引)→2(filter/where)→3/4(统计/趋势,依赖 build_where)与 5(清理,较独立)→6(命令/api)→7(组件)→8(页面集成)→9(e2e)。Task 6 的 `listLogs` 改签名会让 LogsPage 暂时编译错,由 Task 8 修复;实现者若需 Task 6 独立通过 typecheck,可让 `listLogs` 临时兼容(keyword 三元 OR filter 对象)或调整 Task 6/8 边界——dispatch 时向实现者说明。
