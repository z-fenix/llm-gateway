# 日志审计增强(原路线图·阶段3)— 设计

**日期:** 2026-08-10
**分支:** `feat/logs-enhancement`
**前置:** Stage 1 核心网关、Stage 2 安全审计中心、Stage 3 完善与加固均已合并 master(HEAD `0264aa1`)。

> 说明:实际执行的「Stage 3」是完善与加固(锁迁移/quota 原子化/SSE 加固/测试补强/前端 UX)。本设计对应**路线图原定的「阶段 3 · 日志审计增强」**,接续在加固之后。知识库 RAG(原阶段4)为其后独立的下一阶段。

## 1. 目标与范围

在现有日志系统之上做**增量增强**,不重构既有架构、不引入新页面、不引入新运行时依赖:

- **高级搜索/筛选**:结构化 filter bar(密钥/渠道/角色/风险等级/状态分类/日期范围/流式),多条件 AND,与既有 keyword 模糊搜索并存。
- **仪表盘 + 用量统计**:LogsPage 顶部内嵌统计卡片 + 时间趋势图(调用量/Token/成功率/风险分布 四维度,canvas 自绘)。
- **日志清理策略**:手动按日期删除 / 一键清空 + 可选自动保留天数,删除时级联清理关联安全发现。

**安全不变量(不得回归,承袭前两阶段):**
- 真实上游 `channels.api_key` 永不泄露(筛选/统计/趋势/清理均不触碰;仅转发注入 header;前端见 masked)。
- 落库 `request_body`/`response_body` 已**无条件脱敏**(`redact_json_for_logging`);统计/趋势只读聚合数字,**绝不返回** request_body/response_body 原文。
- 删除不影响密钥隔离;清理级联删除 `request_security_findings`,不留孤儿。

## 2. 架构与数据流

沿用现有三层:React 前端(LogsPage)→ Tauri 命令层 → repository(SQLite 单共享连接,parking_lot Mutex)。

**新增/改动分布:**
- **迁移 `003_logs.sql`**:为筛选/聚合加索引(`status_code`、`risk_level`、`api_key_id`、`channel_id`;`created_at`、`trace_id` 已有)。`request_security_findings.log_id` 无 ON DELETE CASCADE → 清理走事务显式双删,不改表结构。
- **`db/repository.rs`**:
  - `list_logs` 重构为接收 `LogFilter` 结构体,返回 `(items, total)`;保持 28 列映射与 keyword 行为向后兼容。
  - `log_stats(&LogFilter) -> LogStats`(聚合:total_calls、total_input/output_tokens、success_rate、按 risk_level 分布、按渠道/密钥 Top5)。
  - `log_timeseries(&LogFilter, bucket_secs) -> Vec<TimeBucket>`(GROUP BY `created_at/bucket`)。
  - `delete_logs_before(ts) -> usize` / `clear_logs() -> usize`(事务:先删 findings 再删 logs,返回删除行数)。
- **命令层 `commands/logs.rs`**:`list_logs(filter, page)`、`get_log_stats(filter)`、`get_log_timeseries(filter, bucket)`、`delete_logs_before(ts)`、`clear_logs()`、`set/get_log_retention_days(days)`。
- **保留天数**:存 tauri-store(`log_retention_days`,0=不自动清理,默认 0),复用 `store.set/save` 模式;`lib.rs` 启动时若 >0 则执行一次 `delete_logs_before(now - days*86400)`,失败仅 `log::error!` 不阻断启动(本地单操作员,无后台定时器)。
- **前端 LogsPage**:filter bar → 触发 `list_logs` + `get_log_stats` + `get_log_timeseries` **三请求联动**;统计卡片 + canvas 趋势面板内嵌于列表上方;清理按钮带确认。

## 3. 筛选字段与聚合 SQL

**`LogFilter`(全部可选,None 不约束;多条件 AND):**
```rust
pub struct LogFilter {
    pub keyword: Option<String>,      // 保留现有模糊:model/trace/channel/key
    pub api_key_id: Option<String>,   // 精确
    pub channel_id: Option<String>,   // 精确
    pub role: Option<String>,         // sonnet/opus/fable/haiku
    pub risk_level: Option<String>,   // clean/info/low/medium/high/critical
    pub status: Option<StatusClass>,  // 2xx/4xx/5xx 分类(非单值)
    pub is_stream: Option<bool>,
    pub after: Option<i64>,           // created_at >= 日期范围起
    pub before: Option<i64>,          // created_at <= 日期范围止
}
```
- `status` 用「分类」映射 `status_code BETWEEN x AND y`(用户更关心 2xx/4xx/5xx 而非单码)。
- 枚举值(role/risk_level/status)由前端下拉提供合法项。

**动态 WHERE 生成器**:抽私有 `build_where(filter) -> (String, Vec<Param>)`,每个 Some 字段追加一条 `AND col op ?N`,绑定参数按序传入。`list_logs` / `log_stats` / `log_timeseries` **三处共用**,保证筛选/统计/趋势联动一致。

**聚合 SQL:**
- `log_stats`:单条 `SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) ... WHERE <filter>`;risk 分布 `GROUP BY risk_level`;Top 渠道/密钥 `GROUP BY channel_name/key_name ORDER BY COUNT(*) DESC LIMIT 5`。
- `log_timeseries`:`SELECT (created_at / ?b) * ?b AS bucket, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(非2xx), SUM(risk_level='clean'), ... (每 risk_level 一列) FROM request_logs WHERE <filter> GROUP BY bucket ORDER BY bucket ASC`。
- **bucket 自适应**:前端按 `after..before` 跨度选 —— ≤48h 用 3600s(小时),否则 86400s(天),传给后端。

## 4. canvas 趋势组件

**组件:** `src/components/LogTrendChart.tsx`,props `{ buckets: TimeBucket[], dimension: Dimension }`。

- **维度切换:** 4 个 tab(调用量/Token/成功率/风险分布),本地 state 切换重绘同一 canvas(**不重新请求** —— `get_log_timeseries` 一次返回全维度数据,前端按 tab 取用)。
- **渲染(canvas 2D 自绘,零依赖):**
  - 尺寸:容器宽自适应,`devicePixelRatio` 缩放,固定高 ~180px。
  - 坐标:X=时间桶(小时桶 `MM-DD HH:00`,天桶 `MM-DD`,稀疏 ~6 刻度);Y 自适应最大值,~4 网格线。
  - 画法:调用量=柱状;Token=双折线(input/output)+图例;成功率=单折线(0–100%);风险分布=堆叠柱状(复用 LogsPage 颜色 clean灰/info蓝/low绿/medium黄/high橙/critical红)。
  - 交互:mousemove 命中最近桶 → 轻量 tooltip(div 绝对定位,显示该桶数值);不引入事件库。
  - 空态/单点:空 buckets 显示「暂无数据」;单桶退化为单柱/单点避免除零。
- **测试:** 渲染逻辑抽纯函数(刻度计算、最大值归一、堆叠求和)供 vitest 单测;canvas 像素断言不做(jsdom 无真实渲染),组件层只测「传入 buckets 不报错 + tab 切换 + 空态文案」。

## 5. 日志清理与自动保留

**手动清理(LogsPage 操作区,两个按钮,均先确认):**
- **按日期删除**:日期选择(截止日)+「删除该日之前日志」。确认文案明确「将删除 YYYY-MM-DD 之前的全部日志及关联安全发现,不可恢复」。确认后 `delete_logs_before(before_ts)`,返回删除行数提示,`load()` 刷新。
- **一键清空**:「清空全部日志」,二次警示,`clear_logs()`,刷新。

**删除实现(事务,级联 findings):**
```rust
let tx = conn.transaction()?;
tx.execute("DELETE FROM request_security_findings WHERE log_id IN (SELECT id FROM request_logs WHERE <条件>)", ...)?;
let n = tx.execute("DELETE FROM request_logs WHERE <条件>", ...)?;
tx.commit()?;
Ok(n)  // 删除的日志行数
```
`clear_logs()` 为无条件版本。先删子表 findings 再删 logs(findings 无 CASCADE)。边界语义:`delete_logs_before(ts)` 删除 `created_at < ts`(「早于该日」),不删等于 ts 的行。

**自动保留天数:**
- 设置 `log_retention_days`(i64,**0=不自动清理**,默认 0)存 tauri-store;UI 在 LogsPage 清理区放数值输入,复用「非负/有限」校验(Stage 3 模式),改动即 `set_log_retention_days`。
- **执行时机:** `lib.rs` 启动时读取,>0 则 `delete_logs_before(now - days*86400)` 一次,失败仅 `log::error!`。与既有设置加载(`merge_from_store`/启动流程)挂同一处。

## 6. 测试策略与验证

**后端(cargo,内存 DB + 集成):**
- `LogFilter` 单/多条件 AND 的 `list_logs` 结果与 `total`;keyword 向后兼容。
- `log_stats` 聚合正确性;`log_timeseries` 分桶(跨桶/空桶/各 risk_level 计数)。
- `delete_logs_before`/`clear_logs` 事务级联(findings 同删、返回行数、边界 `created_at`)。
- `build_where` 三处一致性;保留天数 store 读写 + 0 不清理语义。

**前端(vitest):**
- `LogTrendChart` 纯函数单测 + 组件层(渲染不报错 + 4 tab 切换 + 空态)。
- `LogsPage`:filter bar 变更触发三请求联动;清理按钮弹确认、确认后调 api 并刷新;保留天数输入校验。mock `api.*` 断言调用与参数。

**门槛(每任务):** `cargo test`、`pnpm test:unit`、`pnpm typecheck` 全绿,0 新 warning;`pnpm build`(含 tsc)通过。

**安全回归:** grep 确认统计/趋势/清理路径不返回 `request_body`/`response_body` 原文、不触碰 `channels.api_key`。

**执行方式:** 沿用 SDD(subagent-driven development):按 筛选/统计/趋势/清理/前端 拆任务,每任务 subagent 实现 + 评审(SPEC/QUALITY) → 全部完成后最终全分支评审(Opus) → fast-forward 合并 master。

## 7. 非目标(YAGNI)

- 不新增页面、不引入图表库或其他运行时依赖(canvas 自绘)。
- 不做后台定时清理(仅启动时一次)、不做日志导出。
- 不改变既有 `request_logs`/`request_security_findings` 表结构(仅加索引)。
- 不引入请求体原文的二次展示(统计/趋势仅聚合数字)。
