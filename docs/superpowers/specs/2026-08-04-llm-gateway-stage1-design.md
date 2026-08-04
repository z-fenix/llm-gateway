# llm-gateway 设计文档

> 以 cc-switch 架构为底座、功能对齐 WaLiAPI 的本地 LLM API 网关。
> 核心特色：Claude Code 角色（Sonnet/Opus/Fable/Haiku）路由到不同供应商的上游模型。

- 日期：2026-08-04
- 状态：已确认（架构、数据模型、角色路由、端点/错误/测试均经用户确认）
- 项目位置：`/Users/zhouqiao/workplace/project/llm-gateway`（从零搭建）

---

## 0. 背景与目标

`llm-gateway` 是一个本地运行的 LLM API 网关桌面应用。

- **架构底座**参考 [cc-switch]（Tauri 2 + Rust + axum + SQLite(rusqlite) + React/TS），尤其是其 `proxy/` 模块的多供应商路由、故障切换、熔断、模型映射思路。
- **功能集**对齐 [WaLiAPI]：密钥与配额、负载均衡与故障切换、请求日志与审计、安全审计中心、知识库 RAG、MCP Server。
- **独有特色**：Claude Code 角色路由 —— 把请求里的角色（Sonnet/Opus/Fable/Haiku）路由到指定的「供应商渠道 + 上游模型」，例如 `Sonnet -> Deepseek/deepseek-v4-flash`、`Fable -> kimi/k3-256k`。

**代码来源决策**：从零搭建（不 fork cc-switch，也不直接改 WaLiAPI），按 cc-switch 的架构风格搭建干净、可控的代码库，参考两者的实现模式。

**形态决策**：Tauri 2 桌面应用（内嵌 axum 网关 + SQLite + React/TS 前端），与 cc-switch/WaLiAPI 同构。后续阶段（知识库、MCP、应用配置、托盘）都依赖桌面形态。

---

## 1. 整体路线图（分阶段）

每个阶段都是独立的 spec → plan → 实现循环。本设计文档聚焦**阶段 1**，后续阶段仅列目标，各阶段开始时再细化设计。

### 阶段 1 · 核心网关（MVP）
- 渠道管理（多供应商 CRUD、测试连通性、启停）
- 供应商路由（优先级 + 权重、故障切换）
- **角色路由**（Sonnet/Opus/Fable/Haiku → 渠道+模型，规则表可配，全局兜底）
- 密钥与配额（`sk-lgw-*` 本地密钥、配额、启停、统计）
- 协议接入（Anthropic `/v1/messages` + OpenAI `/v1/chat/completions`，SSE 流式）
- 请求日志（状态码 / Token / 路由 / 工具调用 / 参数入库）
- 基础桌面 UI（渠道 / 密钥 / 角色映射 / 日志 四个页 + 概览）

### 阶段 2 · 安全审计中心
- 风险检测引擎（凭证泄露 / 敏感路径 / 命令外联 / Unicode 隐写 / 追踪像素 / 公网 IP 探测）
- 四模式：审计 / 警告 / 脱敏 / 阻断
- 内置规则库（可启停）+ 自定义黑白名单（域名/工具/路径/关键词）
- 日志页风险等级标签 + 详情面板

### 阶段 3 · 日志审计增强
- 高级搜索/筛选（密钥/渠道/模型/日期范围/TraceID）
- 仪表盘 + 用量统计
- 日志清理策略（按日期删除 / 一键清空）

### 阶段 4 · 知识库 RAG
- 文档解析（Markdown / 代码 / PDF）+ tree-sitter 符号感知
- 智能分块 + 向量化（复用渠道 Embedding）
- HNSW + FTS5 混合检索 + RAG 问答

### 阶段 5 · MCP Server
- Streamable HTTP + SSE，知识库工具集

### 阶段 6 · 应用配置 + 导入导出
- 一键写入 Claude Code / Codex 等 CLI 配置
- 渠道配置导入导出备份

---

## 2. 阶段 1 · 系统架构与模块划分

### 2.1 架构总览

```
下游 AI 工具 (Claude Code / Codex / SDK)
   │  HTTP  Anthropic /v1/messages · OpenAI /v1/chat/completions
   │  认证  x-api-key / Bearer = sk-lgw-*（本地密钥）
   ▼
┌─────────────────────────────────────────────────┐
│  axum 网关（127.0.0.1:PORT，常驻，独立于 UI）      │
│                                                  │
│  协议识别 → 鉴权+配额 → 角色识别 → 渠道调度       │
│     → 模型映射 → 协议转换 → 转发上游 → SSE 回传   │
│     → 日志 + Token 入库                          │
└─────────────────────────────────────────────────┘
   │  HTTPS，注入真实上游 api_key（channels.api_key）
   ▼
上游供应商（OpenAI / Claude / DeepSeek / Gemini / Custom）

Tauri Webview (React UI) ──Tauri Commands──> DB / 配置 / 日志
```

### 2.2 关键设计点

- **网关与 UI 分离**：axum 网关跑在 `127.0.0.1:PORT`，独立于 Tauri webview。前端通过 Tauri Commands 管理配置 / 查日志；下游 AI 工具直接 HTTP 打网关。即使 UI 没开，网关也在跑。
- **协议层与调度层解耦**：入站多协议（Anthropic / OpenAI），内部统一成 OpenAI Chat 格式再调度，出站按渠道 `provider_type` 再转一次。角色路由作用在「统一格式」上，与协议无关。

### 2.3 目录结构

```
llm-gateway/
├── src-tauri/                      # Rust 后端
│   └── src/
│       ├── lib.rs                  # Tauri 入口：初始化 DB、启动网关服务、托盘
│       ├── main.rs
│       ├── db/
│       │   ├── mod.rs              # SQLite 连接池（rusqlite，参考 cc-switch）
│       │   ├── models.rs           # Channel / ApiKey / RoleRoute / RequestLog
│       │   ├── repository.rs       # CRUD + 查询
│       │   └── migrations/         # 001_init.sql ...
│       ├── provider/
│       │   ├── mod.rs              # Provider/Channel 抽象
│       │   └── adapter/            # openai / claude / deepseek / gemini / custom
│       ├── router/
│       │   ├── role.rs             # 角色识别（规则表：模式→角色）
│       │   ├── dispatch.rs         # 渠道调度：优先级+权重、故障切换、兜底
│       │   └── model_map.rs        # 渠道级模型映射
│       ├── proxy/
│       │   ├── server.rs           # axum 服务
│       │   ├── handlers.rs         # /v1/messages, /v1/chat/completions, /v1/models, /health
│       │   ├── forwarder.rs        # 转发上游 + 重试/切换
│       │   ├── sse.rs              # 流式转发 + usage 解析
│       │   └── usage.rs            # Token 统计
│       ├── protocol/
│       │   ├── anthropic.rs        # Anthropic ⇄ OpenAI 双向转换
│       │   └── openai.rs
│       ├── auth.rs                 # sk-* 密钥校验 + 配额检查
│       └── commands/               # Tauri Commands（前端调用）
│           ├── channel.rs  api_key.rs  role_route.rs  log.rs  server.rs  stats.rs
└── src/                            # React 前端
    ├── pages/
    │   ├── ChannelsPage.tsx        # 渠道管理
    │   ├── ApiKeysPage.tsx         # 密钥配额
    │   ├── RoleRoutesPage.tsx      # 角色路由映射 ★
    │   ├── LogsPage.tsx            # 请求日志
    │   └── DashboardPage.tsx       # 概览
    ├── components/ lib/ types/
```

---

## 3. 阶段 1 · 数据模型（SQLite）

第一阶段 6 张表（后续阶段再加安全规则、知识库等表）。

```sql
-- 渠道（上游供应商）
CREATE TABLE channels (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  provider_type TEXT NOT NULL,             -- openai|claude|deepseek|gemini|custom
  base_url      TEXT NOT NULL,
  api_key       TEXT NOT NULL,             -- 真实上游 Key（不对外分发）
  models        TEXT NOT NULL,             -- JSON 数组：该渠道支持的上游模型
  priority      INTEGER NOT NULL DEFAULT 0,-- 优先级（大者优先）
  weight        INTEGER NOT NULL DEFAULT 1,-- 权重（同级内按权重）
  enabled       INTEGER NOT NULL DEFAULT 1,
  timeout_secs  INTEGER NOT NULL DEFAULT 60,
  total_calls   INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  success_rate  REAL    NOT NULL DEFAULT 1.0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 渠道级模型映射（下游模型名 → 上游实际模型名）
CREATE TABLE channel_model_maps (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  UNIQUE(channel_id, source_model)
);

-- 本地访问密钥（分发给下游用户/应用，替代真实上游 Key）
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,      -- sk-lgw-xxxx
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  quota_total   INTEGER,                   -- 总配额（Token 数），NULL=不限
  quota_used    INTEGER NOT NULL DEFAULT 0,
  total_calls   INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- 角色路由表（Claude Code 角色 → 渠道+模型）
CREATE TABLE role_routes (
  id           TEXT PRIMARY KEY,
  role         TEXT NOT NULL UNIQUE,       -- sonnet|opus|fable|haiku（可扩展）
  channel_id   TEXT NOT NULL REFERENCES channels(id),
  target_model TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
);

-- 角色识别规则（模式 → 角色），默认内置 4 条，可增改
CREATE TABLE role_patterns (
  id        TEXT PRIMARY KEY,
  pattern   TEXT NOT NULL,                 -- 通配，如 "*sonnet*"
  role      TEXT NOT NULL,
  priority  INTEGER NOT NULL DEFAULT 0,    -- 多条匹配时按优先级取
  enabled   INTEGER NOT NULL DEFAULT 1
);

-- 请求日志
CREATE TABLE request_logs (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL,          -- 自增编号
  trace_id      TEXT NOT NULL,
  api_key_id    TEXT REFERENCES api_keys(id),
  key_name      TEXT,
  channel_id    TEXT REFERENCES channels(id),
  channel_name  TEXT,
  role          TEXT,
  request_model TEXT,                      -- 下游请求的原始模型名
  upstream_model TEXT,                     -- 实际发往上游的模型名
  protocol      TEXT NOT NULL,             -- anthropic|openai
  status_code   INTEGER,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  is_stream     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  fallback      INTEGER NOT NULL DEFAULT 0,-- 是否触发兜底
  tool_calls    TEXT,                      -- JSON：工具调用摘要
  request_body  TEXT,
  response_body TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX idx_logs_trace   ON request_logs(trace_id);
CREATE INDEX idx_logs_key     ON request_logs(api_key_id);
CREATE INDEX idx_logs_channel ON request_logs(channel_id);
```

**设计说明**：
- `api_keys.key` 是分发给下游的本地密钥；真实上游 Key 只存在 `channels.api_key`，永不出库。
- `role_patterns` 内置 4 条默认规则：`*sonnet*`→sonnet、`*opus*`→opus、`*haiku*`→haiku、`*fable*`→fable，用户可增改、调优先级。
- **全局兜底模型不单独建表**，存 settings（`tauri-plugin-store` 或一张 `settings` 表）：整个网关一条 `{channel_id, target_model}`。
- 日志同时存 `request_model`（原始）、`upstream_model`（映射后）、`role`、`fallback`，便于审计「这个请求为什么路由到了这个上游」。
- **配额以 Token 数计量**（`quota_total` / `quota_used`）。

---

## 4. 阶段 1 · 角色路由核心流程

一次 Claude Code 请求进来后的完整决策链：

```
1. 协议识别
   POST /v1/messages (x-api-key)        → Anthropic 协议
   POST /v1/chat/completions (Bearer)   → OpenAI 协议
   解析出 model 字段（如 "claude-sonnet-4-20250514"）

2. 鉴权 + 配额
   校验 sk-lgw-* 密钥：存在？启用？quota_used < quota_total？
   失败 → 401 / 429

3. 角色识别（router/role.rs）
   按 priority 从高到低遍历 role_patterns，
   第一个 enabled 且 pattern 命中 request.model 的规则 → 得到 role
   例：model="claude-sonnet-4-20250514" 命中 "*sonnet*" → role=sonnet
   若无任何规则命中 → role=NULL（走普通渠道调度）
   匹配大小写不敏感，通配符 "*" 匹配任意字符序列

4. 角色路由（router/dispatch.rs）
   if role 有对应 enabled 的 role_route:
       目标 = (role_route.channel_id, role_route.target_model)
       尝试该渠道转发
       if 失败（网络错 / 5xx / 超时 / 鉴权失败 / 429）:
           尝试全局兜底 (settings.fallback: channel_id + target_model)
           fallback=1 记录日志
       if 兜底也失败 → 返回错误
   else:
       走普通渠道调度：enabled 渠道按 priority 分组，
       同 priority 内按 weight 加权随机选一条，
       失败自动重试同组 / 下一组其他渠道（重试 N 次，可配）

5. 模型映射（router/model_map.rs）
   若走普通调度：查 channel_model_maps，
   把 request.model 映射为该渠道的上游模型名
   （角色路由路径已直接指定 target_model，跳过此步）

6. 协议转换 + 转发（protocol/ + proxy/forwarder.rs）
   统一格式 → 按渠道 provider_type 转成该上游协议 → 转发
   注入真实上游 api_key（channels.api_key）
   SSE 流式透传 + usage 解析

7. 入库（db/repository.rs + proxy/usage.rs）
   记录 request_log（role、request_model、upstream_model、fallback、
                     status_code、input/output_tokens、latency、
                     request/response body、tool_calls）
   更新 api_key.quota_used、channel 统计
```

**关键决策**：
- **角色路由优先于普通调度**：一旦识别出角色且该角色有绑定，就固定走绑定渠道，不参与权重调度。只有「未识别出角色」的请求才走普通负载均衡。
- **触发兜底/切换的「失败」定义**：网络错误、连接超时、HTTP 5xx、429、鉴权失败（401/403）。
- **4xx 业务错误（参数错等）不触发兜底**，原样透传上游错误，避免掩盖调用方错误。
- **兜底只试一次**：角色绑定失败 → 兜底；兜底再失败 → 直接报错。不做无限重试。

---

## 5. 阶段 1 · API 端点、错误处理、测试策略

### 5.1 对外端点（下游 AI 工具用）

| 端点 | 认证 | 说明 |
|---|---|---|
| `POST /v1/messages` | `x-api-key: sk-lgw-*` | Anthropic 协议（Claude Code 主用），SSE 流式 |
| `POST /v1/chat/completions` | `Authorization: Bearer sk-lgw-*` | OpenAI 协议，SSE 流式 |
| `GET /v1/models` | Bearer | 聚合返回：4 个角色名 + 各渠道启用模型 |
| `GET /health` | 无 | 存活探针 |

### 5.2 管理端点（Tauri Commands，前端调用，不走网关端口）

- 渠道 CRUD / 测试连通性
- 密钥 CRUD / 生成 / 配额设置
- 角色路由绑定（role → 渠道+模型）
- 角色识别规则 CRUD
- 全局兜底设置
- 日志查询（分页 / 筛选 / 详情）
- 统计概览

### 5.3 错误处理

| 场景 | 行为 | 返回 |
|---|---|---|
| 密钥无效 / 禁用 | 直接拒绝 | 401 `{error: invalid_api_key}` |
| 配额用尽 | 直接拒绝 | 429 `{error: quota_exceeded}` |
| 角色绑定渠道失败 | 自动落兜底，记 `fallback=1` | 正常返回（调用方无感） |
| 兜底也失败 | 报错 | 502 `{error: upstream_unavailable, trace_id}` |
| 4xx 业务错误（参数错等） | 不兜底，原样透传 | 透传上游状态码 |
| 无可用渠道 | 报错 | 503 `{error: no_available_channel}` |
| 未识别角色且无渠道 | 报错 | 503 |

所有错误都写日志（含 trace_id），调用方拿到 trace_id 可在日志页定位。

### 5.4 测试策略（TDD）

- **单元测试**：角色识别（模式匹配优先级、大小写）、渠道调度（优先级+权重加权随机、故障切换）、模型映射、协议双向转换（Anthropic⇄OpenAI）、配额扣减。
- **集成测试**：用 mock 上游（axum 起假 OpenAI/Anthropic server）跑完整管线 —— 角色路由命中、兜底触发、4xx 不兜底、SSE 流式、Token 统计入库。
- **数据库测试**：rusqlite 用内存库跑（参考 cc-switch `database/tests.rs`）。
- **前端**：关键组件（RoleRoutesPage、ChannelForm）用 vitest + Testing Library。

---

## 6. 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2 |
| 后端 | Rust + axum + reqwest + tokio |
| 数据库 | SQLite (rusqlite, bundled) |
| 配置存储 | tauri-plugin-store |
| 前端 | React + TypeScript + Vite + Tailwind CSS + Zustand + React Router |
| 测试 | cargo test（单元/集成）+ vitest（前端） |

---

[cc-switch]: /Users/zhouqiao/workplace/project/cc-switch
[WaLiAPI]: /Users/zhouqiao/workplace/project/WaLiAPI