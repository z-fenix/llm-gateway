# Task 6 报告: 混合检索(FTS5 + 向量 + RRF 融合)

## 做了什么

1. 新建 `src-tauri/src/knowledge/retrieve.rs`,实现:
   - `RetrievedChunk { embedding_id, content, symbol, filename, score }`
   - 纯函数 `rrf_fuse(vector_hits, fts_hits, top_n) -> Vec<i64>`
   - 异步 `retrieve(state, kb, query, top_n) -> Result<Vec<RetrievedChunk>, String>`
2. 在 `src-tauri/src/knowledge/mod.rs` 加入 `pub mod retrieve;`。
3. 在 `src-tauri/src/db/repository.rs` 加入 `fts_search_chunks(kb_id, query, top_k) -> Vec<(i64, f64)>` 与 FTS5 查询转义辅助函数。
4. 为 `retrieve` 提供索引目录,在 `src-tauri/src/proxy/state.rs` 的 `AppState` 新增 `kb_index_dir: Arc<RwLock<PathBuf>>`,并在 `src-tauri/src/lib.rs` 启动时指向 `app_data_dir/kb/`。
5. TDD 单测覆盖 `rrf_fuse`、`fts_search_chunks`、`retrieve` 集成路径。

## 函数签名

```rust
// src-tauri/src/knowledge/retrieve.rs
pub struct RetrievedChunk {
    pub embedding_id: i64,
    pub content: String,
    pub symbol: Option<String>,
    pub filename: String,
    pub score: f64,
}

pub fn rrf_fuse(
    vector_hits: &[(u64, f32)],
    fts_hits: &[(i64, f64)],
    top_n: usize,
) -> Vec<i64>;

pub async fn retrieve(
    state: &AppState,
    kb: &KnowledgeBase,
    query: &str,
    top_n: usize,
) -> Result<Vec<RetrievedChunk>, String>;

// src-tauri/src/db/repository.rs
pub fn fts_search_chunks(
    &self,
    kb_id: &str,
    query: &str,
    top_k: usize,
) -> AppResult<Vec<(i64, f64)>>;
```

## RRF 公式

- 向量检索结果 `vector_hits` 按列表顺序给出第 1 名(最近)、第 2 名...;
- 全文检索结果 `fts_hits` 按 `ORDER BY rank` 给出第 1 名(最相关)、第 2 名...;
- 对每一路第 `rank` 名的 embedding_id,贡献 `1 / (60 + rank)`;
- 合并相同 embedding_id 的分数,按分数降序取 `top_n`;
- 同分按 embedding_id 升序稳定。

## FTS5 查询转义策略

实现 `fts5_escape`:

1. 将非 `is_alphanumeric()` 字符统一替换为空格(保留 CJK 等字符);
2. `split_whitespace` 得到 token;
3. 每个 token 用双引号包裹,内部双引号转义为 `""`;
4. 多个 token 用空格连接(FTS5 空格 = 隐式 AND);
5. 无有效 token 时直接返回空结果,避免 `MATCH ""` 语法错误。

示例: `alpha keyword` -> `"alpha" "keyword"`;含特殊字符 `foo*bar` -> `"foobar"`。

## retrieve 编排流程

1. `Embedder::from_kb(state, kb)` 获取 embedding 渠道(优先库配置,回退全局默认);
2. `embed([query])` 得到查询向量;
3. `VectorIndex::open_or_create(<kb_index_dir>/<kb_id>.usearch, dim)` 并 `search(query_vec, 20)`;
4. `repo.fts_search_chunks(kb_id, query, 20)`;
5. `rrf_fuse_scored` 融合,取 `top_n` embedding_id;
6. `repo.get_chunks_by_embedding_ids` 回表取 chunk;
7. `repo.list_documents` 映射 `doc_id -> filename`;
8. 按 RRF 顺序组装 `RetrievedChunk`,携带 RRF 分数。

任何步骤 Err 都向上返回,由调用方处理,函数内部不 panic。

## 索引路径策略

- 生产:启动时在 `lib.rs` 将 `AppState.kb_index_dir` 设为 `app_data_dir()/kb/`,与 SQLite 数据库同根目录;
- 测试/默认:`AppState::new` 初始化为 `std::env::temp_dir()/llm-gateway/kb/`;
- 每个库的 usearch 索引文件名为 `<kb_id>.usearch`。

## 测试命令与输出

```bash
# rrf 纯函数
cargo test --manifest-path src-tauri/Cargo.toml --lib rrf_fuse
# output: 3 passed

# FTS 检索
cargo test --manifest-path src-tauri/Cargo.toml --lib fts_search
# output: 1 passed

# retrieve 集成(内存 DB + mock embedding server + temp usearch 索引)
cargo test --manifest-path src-tauri/Cargo.toml --lib retrieve_
# output: 3 passed

# 全量
cargo test --manifest-path src-tauri/Cargo.toml
# output: lib 159 passed; integration tests 38 passed; 0 failed

# 构建
cargo build --manifest-path src-tauri/Cargo.toml
# output: Finished dev profile, 0 warnings
```

## 自审偏差

- `rrf_fuse_merges_and_dedups` 首次断言误将同分场景写错,修正后通过;实际 RRF 中 id4(fts rank2) 得分为 `1/62`,id3(vector rank3) 得分为 `1/63`,id4 应在前。
- `kb_index_dir` 未在原始 Task 6 修改清单中,但 `retrieve` 签名需要 state 提供索引目录,因此补充加入 `AppState`,并在 `lib.rs` 启动时指向 `app_data_dir/kb/`;已在报告说明。
- 文件名通过 `list_documents` 映射而非直接 join SQL,保持 repository 改动最小(仅新增 `fts_search_chunks`)。
- 无新 warning。

## 评审修复(2026-08-11)

针对 Task 6 混合检索评审发现的 2 个 Important + 2 个 Minor 问题,已修复并验证:

1. **并发执行向量与 FTS 检索** (`src-tauri/src/knowledge/retrieve.rs`)
   - 将 `VectorIndex::open_or_create/search` 与 `repo.fts_search_chunks` 分别包入 `tokio::task::spawn_blocking`,再通过 `tokio::try_join!` 并发执行,`retrieve` 保持 `async`。
   - 任一路失败(JoinError 或内部 Err)都会使整体返回 Err,由调用方降级。

2. **缺失 embedding_id 显式报错** (`src-tauri/src/knowledge/retrieve.rs`)
   - 回表后若某个 RRF 结果的 `embedding_id` 在 DB 中找不到,返回 `Err(format!("kb chunk missing for embedding_id {}", id))`。
   - 该静态文案不含敏感信息,会在 `rag_hook` 处触发静默降级。
   - 新增测试 `retrieve_error_when_chunk_missing` 覆盖索引有 id 但 DB 无 chunk 的场景。

3. **FTS5 查询转义保留合法 token 字符** (`src-tauri/src/db/repository.rs`)
   - `fts5_escape` 改为按 Unicode 空白拆分 token,仅对双引号做 `\"\"\"` 转义,再用 `"token1" "token2" ...` 拼接。
   - 下划线、连字符、点号等不再被抹掉,避免 MATCH 语法错误与注入。
   - 更新 `fts_search_chunks_returns_matches`,新增 `under_score` 与 `foo-bar` 查询命中断言。

4. **i64 转换失败不使用哨兵** (`src-tauri/src/knowledge/retrieve.rs`)
   - `rrf_fuse_scored` 中 `i64::try_from(*id)` 失败时返回 `Err(format!("embedding_id {} out of i64 range", id))`。
   - `rrf_fuse`/`rrf_fuse_scored` 签名调整为 `Result`,测试已同步 `.unwrap()`。

验证结果:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
# 159 lib + 38 integration passed; 0 failed
cargo build --manifest-path src-tauri/Cargo.toml
# Finished dev profile, 0 warnings
```
