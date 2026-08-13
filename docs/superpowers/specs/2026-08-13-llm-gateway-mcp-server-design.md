# MCP Server(路线图·阶段5)— 设计

**日期:** 2026-08-13
**分支:** `feat/mcp-server`
**前置:** 阶段 1 核心网关、阶段 2 安全审计中心、阶段 3 完善与加固 + 日志审计增强、阶段 4 知识库 RAG 均已合并 master(HEAD `0c229d2`)。

> 对应路线图「阶段 5 · MCP Server」。在既有内嵌 axum 网关内新增 MCP 端点(Streamable HTTP + SSE),暴露**知识库工具集 + 管理工具**,让 Claude Code 等 MCP 客户端在对话中主动检索/管理知识库。

## 1. 目标与范围

为网关增加 MCP Server:客户端连接 `http://127.0.0.1:<port>/mcp`,经鉴权后调用工具检索知识库、管理知识库、查询用量。

**范围:**
- Streamable HTTP + SSE(rmcp SDK),同端口 `/mcp` 路径。
- 7 个工具:知识库检索/浏览(kb_list_bases / kb_get_base / kb_search)+ 管理(kb_create / kb_upload / kb_delete)+ 用量(stats_quota)。
- 鉴权复用现有 API key(Bearer/x-api-key),仅校验不耗配额。
- 复用现有 `knowledge`/`repository`/`commands::stats` 逻辑,薄 MCP 模块直连。

**非目标(YAGNI):**
- 不做「一键写入 CLI 配置」(阶段 6 · 应用配置);本阶段仅提供 server + 连接说明文档。
- 不做代理聊天工具(发请求转发上游);本阶段纯知识库 + 管理 + 统计。
- 不做 PDF 摄取、本地 embedding(承袭阶段 4 非目标)。

**安全不变量(不得回归,承袭前阶段):**
- 真实 `channels.api_key` 永不泄露;MCP 工具不触碰 key,检索经 `knowledge::retrieve`(key 仅经 `auth_header` 进 embedding 请求 header)。
- `/mcp` 鉴权失败 → 401,不泄露知识库存在性/内容。
- 工具内部错误返回 MCP error,不 panic、不泄露内部异常。
- 落库 body 始终经 `redact_json_for_logging`(既有行为);MCP 不新增日志 body 写入。
- 锁:生产代码 parking_lot `.lock()` 无 `.unwrap()`。

## 2. 架构与数据流

新增 `mcp` 模块(与 `knowledge` 平级),在现有 axum server 上加 `/mcp` 路由,复用 AppState。

```
MCP 客户端 (Claude Code / 任意 MCP client)
   │  http://127.0.0.1:8779/mcp   Authorization: Bearer sk-lgw-*
   ▼
axum server (现有 8777-8787)
   ├─ /mcp (GET=SSE 连接, POST=JSON-RPC)  ← 新增
   │    └─ 鉴权中间件: 复用 auth.rs 校验 Bearer/x-api-key (仅校验, 不耗配额)
   │    └─ rmcp Service (initialize/ping/tools/list/tools/call)
   │         └─ tools.rs: 7 个工具 handler
   │              ├─ kb_list_bases / kb_get_base → repo.list_kbs/get_kb
   │              ├─ kb_search                   → knowledge::retrieve
   │              ├─ kb_create / kb_delete       → repo
   │              ├─ kb_upload                   → base64 → ingest::spawn_ingest
   │              └─ stats_quota                 → 复用 commands/stats 统计逻辑
   ├─ /v1/chat/completions / /v1/messages (不变)
```

**关键集成点:**
- `server.rs` 加 `/mcp` 路由(GET SSE + POST JSON-RPC),路由 handler 内先鉴权再进 rmcp serve。
- `src-tauri/src/mcp/mod.rs`:rmcp `Service` 实现(持有 `AppState`),接线 initialize/ping/tools/list/tools/call。
- `src-tauri/src/mcp/tools.rs`:7 个工具定义(rmcp `#[tool]`/`tool!` 宏)+ handler,直调 `knowledge`/`repository`/统计逻辑。
- rmcp 具体 API 形态实现时 `cargo add rmcp` 验证(网络受限),偏差在实现报告中说明;设计按稳定接口走。

## 3. 工具集规格

全部复用现有逻辑,返回序列化用现有模型(`KnowledgeBase`/`KbDocument`/`RetrievedChunk`),无新 DTO。

| 工具 | 参数 | 返回 | 底层复用 |
|---|---|---|---|
| `kb_list_bases` | — | `KnowledgeBase[]`(name/description/chunk_count/needs_reindex/enabled) | `repo.list_kbs`(含 needs_reindex 计算) |
| `kb_get_base` | `kb_id: string`(先按 id 精确匹配,失败按 name 匹配) | 单库详情 + 文档数 | `repo.get_kb`/`get_kb_by_name`/`list_documents` |
| `kb_search` | `query: string`,`kb_id?`(先 id 后 name,不传用 `rag.default_kb`),`top_k?`(默认 5,上限 20) | `RetrievedChunk[]`(content/symbol/filename/score) | `knowledge::retrieve` |
| `kb_create` | `name`,`description?`,`embedding_channel_id?`(空用 `rag.default_embedding_channel`),`embedding_model`(**必传**,与现有 `create_kb` 命令一致) | 创建结果 | `repo.create_kb` + 建空索引目录 |
| `kb_upload` | `kb_id`,`filename`,`content: string`(纯文本原文) | 文档记录(status=indexing,异步摄取) | 内部 base64 → `ingest::spawn_ingest` |
| `kb_delete` | `kb_id` | 删除结果 | `repo.delete_kb` + 删索引文件 |
| `stats_quota` | — | 全局用量统计(调用/token/配额概览) | 复用 `commands/stats` 统计逻辑 |

**关键点:**
- `kb_search` 复用 `rag.default_kb` 默认库语义(与网关注入一致);`kb_id` 传值则按 id→name 解析到具体库,不传检索默认库。
- `kb_upload` 收纯文本,MCP handler 内部 base64 编码后走现有 `upload_document` 摄取路径(参数与 Tauri 命令对齐,内容形态不同)。
- 工具返回标准 MCP 结果 `content: [{type:"text", text: <JSON>}]`;错误用 MCP error,内部降级不 panic。

## 4. 鉴权与安全

**鉴权**(复用 `auth.rs`,仅校验不耗配额):
- `/mcp` 路由 POST/GET handler 内先校验 `Authorization: Bearer` 或 `x-api-key`,调既有 key 校验(key 存在 + enabled),通过才进 rmcp serve,失败 401。
- 不消耗 token 配额:检索/管理是本地操作;kb_upload 触发摄取调 embedding 渠道是渠道自身调用,不走本地密钥配额。

**安全不变量延续:**
1. MCP 工具不触碰 `channels.api_key`;检索经 `knowledge::retrieve`,工具返回来自 `RetrievedChunk.content/symbol/filename` 与库元数据,无 key 来源。
2. `kb_upload` 复用 `ingest` 链路,失败静默降级(doc status=failed),不 panic、不影响网关聊天路径。
3. SQL 全参数化(走 repo);锁 parking_lot 无 unwrap。
4. 鉴权失败 → 401;工具内部错误返回 MCP error 而非原始内部异常。
5. `kb_upload` 内容经 `redact_json_for_logging` 边界;本阶段不新增日志 body 写入。

**连接说明(供用户测试,阶段 6 才做一键写入):**
- URL `http://127.0.0.1:<port>/mcp`;鉴权头 `Authorization: Bearer <sk-lgw-*>`。
- Claude Code mcp 配置写法示例:`{"mcpServers": {"llm-gateway": {"url": "http://127.0.0.1:8779/mcp", "headers": {"Authorization": "Bearer sk-lgw-..."}}}}`。

## 5. 测试策略与验证

- **单元测试(rmcp 工具层)**:kb_search 参数默认值(不传 kb_id → 默认库、top_k 默认 5/上限 20)、kb_upload base64 编码 → 摄取路径、kb_get_base 按 id/name 解析、各工具错误路径(库不存在 → 工具错误);鉴权中间件(无头/无效 key/禁用 key → 401;有效 key → 放行)。
- **集成测试(经真实网关)**:mock embedding + chat;起网关 → MCP client 连接 `/mcp`(带鉴权头)→ `initialize` → `tools/list`(断言 7 工具 + schema)→ `tools/call kb_search`(摄取一文档后检索命中)→ `kb_upload`/`kb_create`/`kb_delete`/`stats_quota` 调用链;降级(embedding 500 → kb_search 返回工具错误不 panic);无鉴权头 → 401。
- **安全回归 grep**:`api_key` in `src-tauri/src/mcp/`(不得触碰 channels.api_key);MCP 不写日志 body。
- **门槛**:`cargo test` / `pnpm test:unit` / `pnpm typecheck` 全绿,0 新 warning;提交前缀 `feat(mcp):`/`test(mcp):`/`fix(mcp):`,分支 `feat/mcp-server`。
- **真实连接冒烟**(可选不阻塞):MCP inspector 或真实 Claude Code 连接验证。

## 6. 非目标(YAGNI)

- 不做代理聊天工具(转发上游发消息);不做 MCP 管理网关密钥/渠道。
- 不做「一键写入 CLI 配置」(阶段 6);本阶段仅 server + 连接说明。
- 不做多 MCP transport(仅 Streamable HTTP + SSE);不做独立端口隔离。
