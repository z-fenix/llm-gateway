# 知识库 RAG(路线图·阶段4)— 设计

**日期:** 2026-08-11
**分支:** `feat/kb-rag`
**前置:** Stage 1 核心网关、Stage 2 安全审计中心、Stage 3 完善与加固、日志审计增强均已合并 master(HEAD `24345ee`)。

> 对应路线图「阶段 4 · 知识库 RAG」。在既有单进程 Tauri 2 桌面应用内新增 `knowledge` 模块,贯穿「摄取 → 索引 → 检索 → 注入」四段,核心形态为**网关自动注入 context**(客户端零配置,转发前检索知识库注入请求)。

## 1. 目标与范围

为网关增加知识库 RAG:用户上传文档建库,网关在处理聊天请求时自动检索相关知识片段,注入请求 context 后转发上游,客户端无感。

**范围:**
- 多知识库(库→文档→分块 三层)。
- 文档来源:Markdown / 纯文本 / 代码文件(代码用 **tree-sitter 符号感知分块**)。**本阶段不做 PDF。**
- Embedding:**复用渠道 embedding API**(OpenAI 兼容 `/v1/embeddings`)+ **可配置默认 embedding 渠道**作后备。
- 检索:**usearch/HNSW 向量索引 + FTS5 全文**,RRF 融合,混合检索。
- 注入:网关自动注入,**全局开关 + 请求 header(`x-kb`)覆盖**。
- UI:新增 `KnowledgePage`(库/文档管理 + 检索测试 + RAG 设置)。

**安全不变量(不得回归,承袭前阶段):**
- 真实上游 `channels.api_key` 永不泄露;embedding 渠道 key 仅注入 header,不落日志/不进注入文本。
- **注入内容同样过请求侧安检**:注入(rag_hook)发生在 `inspect_request` **之前**,知识库内容里的敏感串会被既有 redact/block 拦住,复用同一信任边界。
- 落库 body 始终经 `redact_json_for_logging` 打码(既有行为,不动)。
- 锁:生产代码 parking_lot `.lock()` 无 `.unwrap()`。

## 2. 架构与数据流

新增 `knowledge` 模块(与 `security` 平级),复用现有分层:React UI → Tauri 命令层 → repository(SQLite)。两类存储:**SQLite 表**(元数据 + FTS5)与 **usearch HNSW 索引文件**(每库一个,存 app 数据目录 `<data_dir>/kb/<kb_id>.usearch`)。

```
摄取: UI 上传 → commands/knowledge → ingest(解析→分块→embedding→写库+写向量)
索引: SQLite: knowledge_bases / kb_documents / kb_chunks(元数据+FTS5)
      usearch: <data_dir>/kb/<kb_id>.usearch (embedding_id ↔ 向量)
检索: query → embedding → usearch ANN(topK) ∥ FTS5 BM25(topK) → RRF 融合 → topN
注入: handlers.rs 安检前 → 若启用 → 检索默认/指定库 → 拼 context 注入 chat.messages → 安检 → 转发
```

**关键集成点:** `handlers.rs` 在请求侧安检(`inspect_request`)**之前**插入 `rag_hook`(与 `security_hook` 同构、独立函数),修改 `chat.messages`。

**降级策略(关键):** RAG 是可选项——embedding 渠道不可用 / 检索超时 / 无命中时,**不注入、正常转发、记 `log::warn!`**,绝不阻断聊天、绝不报错给客户端。与「安全阻断发生在转发前」语义区分:安全可阻断,RAG 故障必须静默降级。

**注入形态(双协议兼容):** topN 片段拼成一个 context 块,作为 `system` 内容注入 `chat.messages` 最前;若已有 system 则 prepend 其内容。经 `build_upstream_body`:OpenAI 走 `messages[0].role=system`,Anthropic 提升为顶层 `system` 字段,两协议天然兼容,无需改 adapter。`ChatMessage.content` 为 `serde_json::Value`:注入 content 用字符串;若原 system content 是块数组(Anthropic),prepend 一个 text block。

## 3. 数据模型与索引

**迁移 `004_knowledge.sql`**(注册进 `MIGRATIONS`):

```sql
CREATE TABLE knowledge_bases (
  id TEXT PRIMARY KEY,  name TEXT NOT NULL UNIQUE,
  description TEXT,  embedding_channel_id TEXT REFERENCES channels(id),
  embedding_model TEXT NOT NULL,  dim INTEGER NOT NULL,
  doc_count INTEGER NOT NULL DEFAULT 0,  chunk_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,  updated_at INTEGER NOT NULL
);
CREATE TABLE kb_documents (
  id TEXT PRIMARY KEY,  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,  file_type TEXT NOT NULL,   -- md|txt|code
  size_bytes INTEGER NOT NULL,  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'indexed',             -- indexing|indexed|failed|needs_reindex
  error TEXT,  created_at INTEGER NOT NULL
);
CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY,  doc_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,  symbol TEXT,                  -- tree-sitter 符号名,可空
  content TEXT NOT NULL,  token_count INTEGER NOT NULL,
  embedding_id INTEGER NOT NULL                        -- 对应 usearch 内 u64 key
);
CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(content, content='kb_chunks', content_rowid='rowid');
-- FTS 外部内容表用触发器与 kb_chunks 同步(after insert/update/delete)
```

**要点:**
- 外键带 `ON DELETE CASCADE`(同 `channel_model_maps`),删库级联删文档/分块(与 `request_security_findings` 无 CASCADE 不同)。
- `embedding_id`:单调递增整数(usearch 用 u64 key);`kb_meta` 表存 `next_embedding_id` 保证唯一/可恢复。
- **usearch 索引与 SQLite 不同步是已知权衡**:启动校验,索引缺失/损坏 → 库标记 `needs_reindex`,UI 提示一键重建(从 `kb_chunks.content` 重新 embedding)。本地单操作员,可重建即可,不追求跨两者事务一致。
- 删除文档:SQLite 删(级联 + FTS 触发器)+ usearch `remove(embedding_id)`。

## 4. 摄取管线

**入口:** `KnowledgePage` 上传文件 → `ingest_document(kb_id, filename, bytes)` → `tokio::spawn` 异步摄取(不阻塞 UI;文档 `status=indexing` → `indexed` / `failed` 记 error)。

**三步:**
1. **解析**:按扩展名分流——`.md`→Markdown;`.txt`/无扩展→纯文本;代码扩展名(`.rs/.ts/.tsx/.js/.py/.go/.java` 等)→代码。PDF 排除。
2. **分块**(`knowledge/chunk.rs`,纯函数可单测):
   - MD/TXT:递归字符分块(按 `##` 标题 → 段落 → 换行降级),目标 ~512 token、重叠 ~50,`chars/4` 估算 token。
   - 代码:tree-sitter 符号感知——按函数/类/方法边界切,符号名写 `kb_chunks.symbol`;超大函数按行递归降级;不支持的扩展名按纯文本降级。
3. **向量化**(`knowledge/embed.rs`):按库 `embedding_channel_id`(或全局默认)取 channel,构造 OpenAI `/v1/embeddings`(`auth_header` 复用,key 仅注入 header),批量(32 chunk/次)调用,得 `Vec<f32>`;写 usearch `add(embedding_id, vec)` + 更新 `kb_chunks`。**维度 `dim`** 以首次成功为准锁库,后续校验一致。

**降级:** embedding 失败 → 文档 `failed` 记 error 可重试;绝不影响网关转发。分块/解析为纯函数,充分单测;embedding 用 mock 渠道测。

## 5. 检索与注入

**检索**(`knowledge/retrieve.rs`):
1. query → 同一 embedding 渠道向量化(单次)。
2. 两路并行召回:usearch ANN `search(vec, topK)` ∥ FTS5 `MATCH query ORDER BY rank`(topK≈20)。
3. **RRF 融合**:`score = Σ 1/(60 + rank_i)`,取 **topN≈5**。
4. `embedding_id ↔ chunk.id` 回表取 `content`/`symbol`/`filename`。

**注入**(`knowledge/rag_hook.rs`,handlers.rs 安检前调用):
- **开关**:store `rag_enabled`(bool)+ `rag_default_kb`;header `x-kb: <name|off>` 覆盖,优先级最高。
- **判定**:启用且库 `enabled` → 取用户最后一条消息文本做 query → 检索。
- **注入**:有命中(分数>阈值)则拼 context 块(见下),作为 system 内容注入 `chat.messages` 最前(已有 system 则 prepend;Anthropic 块数组 prepend text block)。context 总长封顶 ~2000 token,超出截断 topN。
- **降级**:embedding 失败 / 检索超时(`tokio::time::timeout` ~2s)/ 无命中 → 不注入正常转发,记 warn。

**context 块格式:**
```
[知识库参考资料]
--- 片段1 (来自 guide.md · 函数 foo) ---
<content>
...
请基于以上资料回答,不相关则忽略。
```

## 6. UI、命令层

**UI — 新增 `KnowledgePage`**(首个新页面,进侧边栏导航):
- 库管理:列表(名称/文档数/分块数/embedding 渠道/启用)+ 新建库(选 embedding 渠道+模型)+ 删除库(级联)+ 重建索引(needs_reindex 时)。
- 文档管理:库内上传(多选)、文档列表(文件名/类型/分块数/状态/错误)、删除文档。
- 检索测试:输入 query → 显示 topN 片段(来源/符号/融合分数)。
- RAG 设置:全局开关 `rag_enabled` + 默认知识库(写 store)。

**命令层**(`commands/knowledge.rs`,复用 store/repo 模式):`create_kb/list_kbs/delete_kb/reindex_kb/upload_document/list_documents/delete_document/search_kb/set_rag_enabled/get_rag_settings`,注册进 `generate_handler!`。

## 7. 测试策略与验证

- **纯函数单测(重点):** 分块(MD 递归 / 代码 tree-sitter 符号边界 / 超长降级 / 重叠)、RRF 融合(两路合并/去重/topN)、context 拼接与 token 截断、OpenAI/Anthropic 注入形态(system 字符串 vs 块数组 prepend)。
- **repository 单测:** 三表 CRUD + 级联删除 + FTS 触发器同步 + embedding_id 单调。
- **集成测试(经真实网关):** mock embedding 渠道(`tests/common::spawn_mock` 加 `/v1/embeddings` 路由)→ 摄取文档 → 发聊天请求带 `x-kb` → 断言注入后上游 body 含 context;断言 `x-kb: off` 与 embedding 故障时降级(正常转发、无注入、不报错)。
- **安全回归 grep:** 注入路径不泄露 embedding 渠道 api_key;注入内容经请求侧安检(注入在安检前)。

**门槛:** `cargo test` / `pnpm test:unit` / `pnpm typecheck` 全绿,0 新 warning;改前端 `pnpm build:renderer` 通过。
**提交前缀** `feat(kb):` / `test(kb):` / `fix(kb):`,分支 `feat/kb-rag`。
**执行方式:** 沿用 SDD(subagent-driven development),按 迁移/分块/embedding/检索/注入/命令/UI/e2e 拆任务,每任务 subagent 实现 + 评审 → 最终全分支评审(Opus)→ fast-forward 合并 master。

## 8. 非目标(YAGNI)

- 不做 PDF 解析;不做本地 embedding 模型(fastembed/onnx)。
- 不做 MCP Server 知识库工具集(阶段 5);本阶段仅网关注入 + 管理 UI + 检索测试。
- 不做增量/监听式文档同步(手动上传/重建即可);不追求 usearch 与 SQLite 跨存储事务一致(可重建)。
- 不做按角色/密钥绑定知识库(全局 + header 覆盖即可)。
