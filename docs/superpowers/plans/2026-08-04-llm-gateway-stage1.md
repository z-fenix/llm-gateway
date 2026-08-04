# llm-gateway 阶段1 · 核心网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零搭建一个 Tauri 2 桌面 LLM 网关，实现渠道管理、优先级+权重路由、Claude Code 角色路由（Sonnet/Opus/Fable/Haiku → 多供应商上游模型，全局兜底）、本地密钥配额、Anthropic/OpenAI 双协议接入（SSE 流式）与请求日志入库，并提供基础桌面 UI。

**Architecture:** Tauri 2 壳内嵌常驻 axum 网关（`127.0.0.1:8777`），与 UI 分离。请求管线：协议识别 → 鉴权+配额 → 角色识别 → 渠道调度（优先级+权重）→ 模型映射 → 协议转换 → 转发上游 → SSE 回传 → 日志+Token 入库。入站多协议统一为 OpenAI Chat 格式再调度，出站按渠道 provider_type 再转换。SQLite(rusqlite) 持久化，前端 React 通过 Tauri Commands 管理配置/查日志。

**Tech Stack:** Rust 1.96 / Tauri 2.11 / axum 0.8 / rusqlite 0.40 (bundled) / reqwest 0.13 / tokio 1.53 / serde_json 1.0 / uuid 1.24 / React 18 / TypeScript 5 / Vite 7 / Tailwind 3 / Zustand / React Router 7 / vitest 2。

**Spec:** `docs/superpowers/specs/2026-08-04-llm-gateway-stage1-design.md`

## Global Constraints

- 本地密钥前缀：`sk-lgw-`（llm-gateway），格式 `sk-lgw-<32位hex>`。
- 网关默认监听 `127.0.0.1:8777`，只绑回环地址，不暴露公网。
- 真实上游 Key 仅存 `channels.api_key`，永不出库、永不下发到前端日志明文展示（前端展示打码）。
- 角色路由优先于普通权重调度；角色绑定失败走全局兜底（全局仅一条，存 settings）；4xx 业务错误不触发兜底。
- 触发兜底/重试的「失败」：网络错误、连接超时、HTTP 5xx、429、401/403。其余 4xx 直接透传。
- 兜底只试一次；普通调度重试次数默认 2 次（可配）。
- 角色识别大小写不敏感，通配符 `*` 匹配任意字符序列。
- 配额以 Token 数计量（`quota_total` / `quota_used`）。
- Rust edition 2021（与 Tauri 2 模板一致；仓库根的 edition 2024 脚手架由本计划替换）。
- 数据库迁移放 `src-tauri/migrations/NNN_name.sql`，从 `001_init.sql` 起。
- 所有错误日志含 `trace_id`（uuid v4）。
- TDD：每个逻辑任务先写失败测试，再实现，再验证通过，再提交。频繁提交。

---

## File Structure（阶段1 落地文件总览）

```
Cargo.toml                              # workspace 根（替换现有脚手架）→ 实际只留 src-tauri
src-tauri/
  Cargo.toml                            # 后端 crate
  build.rs
  tauri.conf.json
  migrations/001_init.sql               # 6 张表 + 索引 + 默认角色规则
  src/
    main.rs
    lib.rs                              # Tauri 入口、初始化 DB、启动网关
    error.rs                            # AppError 统一错误
    db/
      mod.rs                            # Db（rusqlite 连接池 + 迁移执行）
      models.rs                         # Channel/ApiKey/RoleRoute/RolePattern/RequestLog
      repository.rs                     # 全部 CRUD + 查询（sync，Mutex<Connection>）
    auth.rs                             # 密钥校验 + 配额检查/扣减
    router/
      mod.rs
      role.rs                           # 角色识别（模式匹配）
      dispatch.rs                       # 渠道调度（优先级+权重、故障切换、兜底）
      model_map.rs                      # 渠道级模型映射
    protocol/
      mod.rs
      types.rs                          # 统一 OpenAI Chat 内部格式
      anthropic.rs                      # Anthropic ⇄ 统一格式
      openai.rs                         # OpenAI ⇄ 统一格式（基本直通）
    provider/
      mod.rs                            # ProviderType + 出站协议适配
      adapter.rs                        # build_upstream_request（按 provider_type 转换）
    proxy/
      mod.rs
      server.rs                         # axum Router + 启动/停止
      handlers.rs                       # /v1/messages, /v1/chat/completions, /v1/models, /health
      forwarder.rs                      # 转发上游 + 重试/切换/兜底 + SSE
      sse.rs                            # SSE 流式解析 + usage 累积
      state.rs                          # AppState（Db + 配置 + http client）
    commands/
      mod.rs
      channel.rs                        # 渠道 CRUD + 测试
      api_key.rs                        # 密钥 CRUD + 生成 + 配额
      role_route.rs                     # 角色路由 + 识别规则 + 兜底设置
      log.rs                            # 日志查询
      stats.rs                          # 概览统计
package.json / vite.config.ts / tsconfig.json / tailwind.config.cjs / postcss.config.cjs
index.html
src/
  main.tsx  App.tsx  index.css
  types/index.ts                        # 与后端 serde 对应的 TS 类型
  lib/api.ts                            # invoke 封装
  pages/DashboardPage.tsx ChannelsPage.tsx ApiKeysPage.tsx RoleRoutesPage.tsx LogsPage.tsx
  components/Layout.tsx ChannelForm.tsx
tests/                                  # Rust 集成测试
  common/mod.rs                         # mock 上游 server + 测试 DB 工具
  role_route_flow.rs                    # 端到端：角色命中/兜底/4xx不透传/SSE/Token入库
```

---

## Task 1: 后端 crate 脚手架 + 数据库层 + 迁移

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/migrations/001_init.sql`
- Create: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/models.rs`
- Create: `src-tauri/src/db/repository.rs`
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/main.rs`
- Delete: `Cargo.toml`（根脚手架）、`src/main.rs`（根脚手架）、`Cargo.lock`（重新生成）
- Test: `src-tauri/src/db/repository.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Produces:
  - `Db::new_in_memory() -> Db`、`Db::open(path: &Path) -> Result<Db>`（执行迁移）
  - `Db` 内部 `conn: Arc<Mutex<rusqlite::Connection>>`，`Db::conn() -> Arc<Mutex<Connection>>`
  - models：`Channel { id,name,provider_type,base_url,api_key,models:Vec<String>,priority:i64,weight:i64,enabled:bool,timeout_secs:i64,total_calls:i64,total_tokens:i64,success_rate:f64,avg_latency_ms:i64,created_at:i64,updated_at:i64 }`
  - `ApiKey { id,key,name,enabled,quota_total:Option<i64>,quota_used:i64,total_calls:i64,total_tokens:i64,created_at:i64,last_used_at:Option<i64> }`
  - `RoleRoute { id,role,channel_id,target_model,enabled,updated_at }`
  - `RolePattern { id,pattern,role,priority:i64,enabled }`
  - `RequestLog { id,seq,trace_id,api_key_id:Option<String>,key_name:Option<String>,channel_id:Option<String>,channel_name:Option<String>,role:Option<String>,request_model:Option<String>,upstream_model:Option<String>,protocol,status_code:Option<i64>,input_tokens:i64,output_tokens:i64,latency_ms:i64,is_stream:bool,error:Option<String>,fallback:bool,tool_calls:Option<String>,request_body:Option<String>,response_body:Option<String>,created_at:i64 }`
  - repository 方法（本任务先实现 channel + api_key 的最小集，后续任务补）：
    - `insert_channel(&self, c:&Channel) -> Result<()>`
    - `get_channel(&self, id:&str) -> Result<Option<Channel>>`
    - `list_channels(&self) -> Result<Vec<Channel>>`
    - `insert_api_key(&self, k:&ApiKey) -> Result<()>`
    - `get_api_key_by_key(&self, key:&str) -> Result<Option<ApiKey>>`
  - `error::AppError`（`thiserror`，含 `Db(#[from] rusqlite::Error)` 等）与 `type AppResult<T> = Result<T, AppError>`

- [ ] **Step 1: 删除根脚手架，建立 src-tauri 布局**

```bash
cd /Users/zhouqiao/workplace/project/llm-gateway
git rm -q Cargo.toml Cargo.lock src/main.rs 2>/dev/null || rm -f Cargo.toml Cargo.lock src/main.rs
rmdir src 2>/dev/null || true
mkdir -p src-tauri/src/db src-tauri/migrations
```

- [ ] **Step 2: 写 `src-tauri/Cargo.toml`**

```toml
[package]
name = "llm-gateway"
version = "0.1.0"
edition = "2021"
rust-version = "1.85"

[lib]
name = "llm_gateway_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
doctest = false

[build-dependencies]
tauri-build = { version = "2.6", features = [] }

[dependencies]
tauri = { version = "2.11", features = [] }
tauri-plugin-store = "2"
serde = { version = "1.0", features = ["derive"] }
serde_json = { version = "1.0", features = ["preserve_order"] }
thiserror = "2.0"
anyhow = "1.0"
rusqlite = { version = "0.40", features = ["bundled"] }
tokio = { version = "1.53", features = ["macros", "rt-multi-thread", "time", "sync"] }
axum = "0.8"
reqwest = { version = "0.13", features = ["rustls-tls", "json", "stream"] }
futures = "0.3"
bytes = "1.5"
uuid = { version = "1.24", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
log = "0.4"

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: 写 `src-tauri/build.rs` 与 `src-tauri/src/main.rs`、`src-tauri/src/lib.rs` 占位**

`build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src/main.rs`:
```rust
fn main() {
    llm_gateway_lib::run()
}
```

`src/lib.rs`（先只暴露模块，`run()` 后续任务填充）：
```rust
pub mod db;
pub mod error;

pub fn run() {
    // Tauri 启动逻辑在后续任务实现
}
```

- [ ] **Step 4: 写 `src-tauri/migrations/001_init.sql`（6 表 + 索引 + 默认角色规则）**

```sql
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_secs INTEGER NOT NULL DEFAULT 60,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 1.0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_model_maps (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  UNIQUE(channel_id, source_model)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_total INTEGER,
  quota_used INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS role_routes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  target_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  role TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  api_key_id TEXT REFERENCES api_keys(id),
  key_name TEXT,
  channel_id TEXT REFERENCES channels(id),
  channel_name TEXT,
  role TEXT,
  request_model TEXT,
  upstream_model TEXT,
  protocol TEXT NOT NULL,
  status_code INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fallback INTEGER NOT NULL DEFAULT 0,
  tool_calls TEXT,
  request_body TEXT,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_trace ON request_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs(channel_id);

-- 默认角色识别规则（大小写不敏感在代码层处理）
INSERT INTO role_patterns (id, pattern, role, priority, enabled) VALUES
  ('pat-sonnet', '*sonnet*', 'sonnet', 100, 1),
  ('pat-opus',   '*opus*',   'opus',   100, 1),
  ('pat-haiku',  '*haiku*',  'haiku',  100, 1),
  ('pat-fable',  '*fable*',  'fable',  100, 1);
```

- [ ] **Step 5: 写 `src-tauri/src/error.rs`**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("http error: {0}")]
    Http(String),
    #[error("{0}")]
    Msg(String),
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 6: 写 `src-tauri/src/db/models.rs`（struct 定义 + serde）**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub priority: i64,
    pub weight: i64,
    pub enabled: bool,
    pub timeout_secs: i64,
    pub total_calls: i64,
    pub total_tokens: i64,
    pub success_rate: f64,
    pub avg_latency_ms: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub id: String,
    pub key: String,
    pub name: String,
    pub enabled: bool,
    pub quota_total: Option<i64>,
    pub quota_used: i64,
    pub total_calls: i64,
    pub total_tokens: i64,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRoute {
    pub id: String,
    pub role: String,
    pub channel_id: String,
    pub target_model: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolePattern {
    pub id: String,
    pub pattern: String,
    pub role: String,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLog {
    pub id: String,
    pub seq: i64,
    pub trace_id: String,
    pub api_key_id: Option<String>,
    pub key_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub role: Option<String>,
    pub request_model: Option<String>,
    pub upstream_model: Option<String>,
    pub protocol: String,
    pub status_code: Option<i64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub latency_ms: i64,
    pub is_stream: bool,
    pub error: Option<String>,
    pub fallback: bool,
    pub tool_calls: Option<String>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub created_at: i64,
}
```

- [ ] **Step 7: 写 `src-tauri/src/db/mod.rs`（连接 + 迁移）**

```rust
pub mod models;
pub mod repository;

use crate::error::AppResult;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

const MIGRATIONS: &[&str] = &[include_str!("../../migrations/001_init.sql")];

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn new_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn: Arc::new(Mutex::new(conn)) };
        db.migrate()?;
        Ok(db)
    }

    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn: Arc::new(Mutex::new(conn)) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // 记录已应用版本
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations(version INTEGER PRIMARY KEY);",
        )?;
        let applied: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM _migrations",
            [],
            |r| r.get(0),
        )?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let version = (i + 1) as i64;
            if version > applied {
                conn.execute_batch(sql)?;
                conn.execute("INSERT INTO _migrations(version) VALUES (?1)", [version])?;
            }
        }
        Ok(())
    }

    pub fn conn(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }
}
```

- [ ] **Step 8: 写 `src-tauri/src/db/repository.rs`（最小 CRUD + 内嵌测试）**

```rust
use super::models::{ApiKey, Channel};
use super::Db;
use crate::error::AppResult;
use rusqlite::params;

pub struct Repository {
    pub db: Db,
}

impl Repository {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn insert_channel(&self, c: &Channel) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO channels (id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                c.id, c.name, c.provider_type, c.base_url, c.api_key,
                serde_json::to_string(&c.models).unwrap(),
                c.priority, c.weight, c.enabled as i64, c.timeout_secs,
                c.total_calls, c.total_tokens, c.success_rate, c.avg_latency_ms,
                c.created_at, c.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_channel(&self, id: &str) -> AppResult<Option<Channel>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_channel(r)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_channels(&self) -> AppResult<Vec<Channel>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels ORDER BY priority DESC, created_at ASC",
        )?;
        let rows = stmt.query_map([], row_to_channel)?;
        let mut out = Vec::new();
        for c in rows {
            out.push(c?);
        }
        Ok(out)
    }

    pub fn insert_api_key(&self, k: &ApiKey) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO api_keys (id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                k.id, k.key, k.name, k.enabled as i64, k.quota_total, k.quota_used,
                k.total_calls, k.total_tokens, k.created_at, k.last_used_at
            ],
        )?;
        Ok(())
    }

    pub fn get_api_key_by_key(&self, key: &str) -> AppResult<Option<ApiKey>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at FROM api_keys WHERE key=?1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(r) = rows.next()? {
            Ok(Some(ApiKey {
                id: r.get(0)?,
                key: r.get(1)?,
                name: r.get(2)?,
                enabled: r.get::<_, i64>(3)? != 0,
                quota_total: r.get(4)?,
                quota_used: r.get(5)?,
                total_calls: r.get(6)?,
                total_tokens: r.get(7)?,
                created_at: r.get(8)?,
                last_used_at: r.get(9)?,
            }))
        } else {
            Ok(None)
        }
    }
}

fn row_to_channel(r: &rusqlite::Row) -> rusqlite::Result<Channel> {
    let models_json: String = r.get(5)?;
    Ok(Channel {
        id: r.get(0)?,
        name: r.get(1)?,
        provider_type: r.get(2)?,
        base_url: r.get(3)?,
        api_key: r.get(4)?,
        models: serde_json::from_str(&models_json).unwrap_or_default(),
        priority: r.get(6)?,
        weight: r.get(7)?,
        enabled: r.get::<_, i64>(8)? != 0,
        timeout_secs: r.get(9)?,
        total_calls: r.get(10)?,
        total_tokens: r.get(11)?,
        success_rate: r.get(12)?,
        avg_latency_ms: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str) -> Channel {
        Channel {
            id: id.into(), name: "n".into(), provider_type: "openai".into(),
            base_url: "http://x".into(), api_key: "sk-real".into(),
            models: vec!["gpt-4o".into()], priority: 0, weight: 1, enabled: true,
            timeout_secs: 60, total_calls: 0, total_tokens: 0, success_rate: 1.0,
            avg_latency_ms: 0, created_at: 1, updated_at: 1,
        }
    }

    #[test]
    fn channel_roundtrip() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("c1")).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.api_key, "sk-real");
        assert_eq!(got.models, vec!["gpt-4o".to_string()]);
        assert!(got.enabled);
    }

    #[test]
    fn apikey_lookup_by_key() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-abc".into(), name: "alice".into(),
            enabled: true, quota_total: Some(1000), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        let got = repo.get_api_key_by_key("sk-lgw-abc").unwrap().unwrap();
        assert_eq!(got.name, "alice");
        assert_eq!(got.quota_total, Some(1000));
        assert!(repo.get_api_key_by_key("nope").unwrap().is_none());
    }

    #[test]
    fn default_role_patterns_seeded() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let conn = repo.db.conn();
        let conn = conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM role_patterns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 4);
    }
}
```

- [ ] **Step 9: 编译并跑测试**

Run: `cd src-tauri && cargo test --lib`
Expected: 编译通过，`channel_roundtrip`、`apikey_lookup_by_key`、`default_role_patterns_seeded` 全部 PASS。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(stage1): 后端脚手架 + SQLite 数据库层 + 初始迁移(6表+默认角色规则)"
```

---

## Task 2: 角色识别引擎（router/role.rs）

**Files:**
- Create: `src-tauri/src/router/mod.rs`
- Create: `src-tauri/src/router/role.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod router;`）
- Test: `src-tauri/src/router/role.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `db::Db`（读 `role_patterns` 表，Task 1）
- Produces:
  - `wildcard_match(pattern: &str, text: &str) -> bool` —— 大小写不敏感，`*` 匹配任意序列
  - `detect_role(conn: &rusqlite::Connection, model: &str) -> Option<String>` —— 按 priority DESC 取第一条 enabled 且命中规则的 role

- [ ] **Step 1: 写失败测试**

`src-tauri/src/router/role.rs`:
```rust
use crate::db::Db;

/// 大小写不敏感通配匹配：`*` 匹配任意字符序列（含空）。
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p = pattern.to_lowercase();
    let t = text.to_lowercase();
    let p: Vec<char> = p.chars().collect();
    let t: Vec<char> = t.chars().collect();
    wildcard_inner(&p, &t)
}

fn wildcard_inner(p: &[char], t: &[char]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    if p[0] == '*' {
        // `*` 匹配 0..=t.len() 个字符
        for skip in 0..=t.len() {
            if wildcard_inner(&p[1..], &t[skip..]) {
                return true;
            }
        }
        return false;
    }
    if t.is_empty() {
        return false;
    }
    if p[0] == t[0] {
        return wildcard_inner(&p[1..], &t[1..]);
    }
    false
}

/// 从 role_patterns 表按 priority 降序找第一条启用且命中 model 的规则，返回其 role。
pub fn detect_role(conn: &rusqlite::Connection, model: &str) -> Option<String> {
    let mut stmt = conn
        .prepare("SELECT pattern, role FROM role_patterns WHERE enabled=1 ORDER BY priority DESC")
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .ok()?;
    for row in rows.flatten() {
        if wildcard_match(&row.0, model) {
            return Some(row.1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_cases() {
        assert!(wildcard_match("*sonnet*", "claude-sonnet-4-20250514"));
        assert!(wildcard_match("*Sonnet*", "CLAUDE-SONNET-4")); // 大小写不敏感
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("gpt-4o", "gpt-4o"));
        assert!(!wildcard_match("*opus*", "claude-sonnet-4"));
        assert!(!wildcard_match("sonnet", "claude-sonnet-4")); // 无通配需全等
        assert!(wildcard_match("claude-*-4", "claude-sonnet-4"));
    }

    #[test]
    fn detect_role_from_seed_rules() {
        let db = Db::new_in_memory().unwrap();
        let conn = db.conn();
        let conn = conn.lock().unwrap();
        assert_eq!(
            detect_role(&conn, "claude-sonnet-4-20250514"),
            Some("sonnet".to_string())
        );
        assert_eq!(detect_role(&conn, "claude-opus-4"), Some("opus".to_string()));
        assert_eq!(detect_role(&conn, "claude-haiku-3"), Some("haiku".to_string()));
        assert_eq!(detect_role(&conn, "claude-fable-5"), Some("fable".to_string()));
        assert_eq!(detect_role(&conn, "gpt-4o"), None);
    }

    #[test]
    fn higher_priority_rule_wins() {
        let db = Db::new_in_memory().unwrap();
        let conn = db.conn();
        {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO role_patterns (id,pattern,role,priority,enabled) VALUES ('px','*sonnet-4*','custom-sonnet',200,1)",
                [],
            )
            .unwrap();
            assert_eq!(
                detect_role(&conn, "claude-sonnet-4"),
                Some("custom-sonnet".to_string())
            );
        }
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib router::role`
Expected: FAIL —— `router` 模块未在 lib.rs 注册（`unresolved import crate::db` 在 router 模块找不到 / module not found）。

- [ ] **Step 3: 注册模块**

`src-tauri/src/router/mod.rs`:
```rust
pub mod role;
```
`src-tauri/src/lib.rs` 顶部加：
```rust
pub mod router;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib router::role`
Expected: `wildcard_cases`、`detect_role_from_seed_rules`、`higher_priority_rule_wins` 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): 角色识别引擎（大小写不敏感通配 + 优先级规则表）"
```

---

## Task 3: 渠道调度器（router/dispatch.rs）— 优先级+权重+故障切换+兜底

**Files:**
- Create: `src-tauri/src/router/dispatch.rs`
- Modify: `src-tauri/src/router/mod.rs`（加 `pub mod dispatch;`）
- Test: `src-tauri/src/router/dispatch.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `db::models::Channel`、`router::role`（Task 2）
- Produces:
  - `RouteTarget { channel: Channel, model: String, via_fallback: bool }`
  - `plan_route(channels: &[Channel], role: Option<&str>, role_route: Option<(Channel,String)>, fallback: Option<(Channel,String)>, request_model: &str) -> Vec<RouteTarget>` —— 返回按尝试顺序排列的候选目标列表（第一个为主目标，其余为重试/兜底）。纯函数，便于测试。
  - `weighted_pick(candidates: &[Channel], seed: u64) -> Option<Channel>` —— 同 priority 组内按 weight 加权选择。

**说明（设计定型）**：
- 调度输出一个**有序候选列表** `Vec<RouteTarget>`，由 forwarder 依序尝试，失败（5xx/网络/超时/429/401/403）才用下一个，4xx 直接停。
- 角色路由路径：`role_route` 存在 → 候选 = [角色绑定, 全局兜底(若有)]。普通调度路径：候选 = 普通调度排序后的渠道（每条 model 经模型映射），不自动追加兜底（兜底是角色路由特性）。
- 本任务只做**纯函数排序/选择逻辑**，不发 HTTP（forwarder 在 Task 8 做）。确定性测试靠传入 `seed`。

- [ ] **Step 1: 写失败测试**

`src-tauri/src/router/dispatch.rs`:
```rust
use crate::db::models::Channel;

#[derive(Debug, Clone, PartialEq)]
pub struct RouteTarget {
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
}

/// 同 priority 组内按 weight 加权随机（seed 决定可复现）。weight<=0 视为 1。
pub fn weighted_pick(candidates: &[Channel], seed: u64) -> Option<Channel> {
    if candidates.is_empty() {
        return None;
    }
    let total: u64 = candidates
        .iter()
        .map(|c| c.weight.max(1) as u64)
        .sum();
    let mut roll = seed % total;
    for c in candidates {
        let w = c.weight.max(1) as u64;
        if roll < w {
            return Some(c.clone());
        }
        roll -= w;
    }
    candidates.last().cloned()
}

/// 规划一次请求的有序候选目标列表。
/// - 角色路由：role_route 给 (channel, model)，候选 = [角色, 兜底?]
/// - 普通调度：按 priority 降序、组内 seed 稳定顺序展开 enabled 渠道，model 取映射或原样
pub fn plan_route(
    role_route: Option<(Channel, String)>,
    fallback: Option<(Channel, String)>,
    normal_channels: &[Channel],
    resolve_model: &dyn Fn(&Channel, &str) -> String,
    request_model: &str,
    seed: u64,
) -> Vec<RouteTarget> {
    // 角色路由优先
    if let Some((ch, model)) = role_route {
        let mut out = vec![RouteTarget {
            channel: ch,
            model,
            via_fallback: false,
        }];
        if let Some((fch, fmodel)) = fallback {
            out.push(RouteTarget {
                channel: fch,
                model: fmodel,
                via_fallback: true,
            });
        }
        return out;
    }

    // 普通调度：按 priority 分组，组内按权重做带 seed 的加权洗牌
    let mut enabled: Vec<Channel> = normal_channels.iter().filter(|c| c.enabled).cloned().collect();
    if enabled.is_empty() {
        return Vec::new();
    }
    enabled.sort_by(|a, b| b.priority.cmp(&a.priority));
    let mut out = Vec::new();
    let mut i = 0;
    let mut s = seed;
    while i < enabled.len() {
        let prio = enabled[i].priority;
        let mut group: Vec<Channel> = Vec::new();
        while i < enabled.len() && enabled[i].priority == prio {
            group.push(enabled[i].clone());
            i += 1;
        }
        // 组内反复 weighted_pick 直到取空，形成有序序列
        let mut g = group;
        while !g.is_empty() {
            if let Some(pick) = weighted_pick(&g, s) {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1); // LCG 推进
                g.retain(|c| c.id != pick.id);
                let model = resolve_model(&pick, request_model);
                out.push(RouteTarget { channel: pick, model, via_fallback: false });
            } else {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str, prio: i64, weight: i64) -> Channel {
        Channel {
            id: id.into(), name: id.into(), provider_type: "openai".into(),
            base_url: "http://x".into(), api_key: "k".into(), models: vec![],
            priority: prio, weight, enabled: true, timeout_secs: 60,
            total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
            created_at: 1, updated_at: 1,
        }
    }

    fn identity(_c: &Channel, m: &str) -> String { m.to_string() }

    #[test]
    fn role_route_beats_normal_and_appends_fallback() {
        let role_ch = ch("role-ch", 0, 1);
        let fb_ch = ch("fb-ch", 0, 1);
        let normal = vec![ch("n1", 100, 1)];
        let plan = plan_route(
            Some((role_ch, "deepseek-v4-flash".into())),
            Some((fb_ch, "kimi-k3".into())),
            &normal, &identity, "claude-sonnet-4", 42,
        );
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].channel.id, "role-ch");
        assert_eq!(plan[0].model, "deepseek-v4-flash");
        assert!(!plan[0].via_fallback);
        assert_eq!(plan[1].channel.id, "fb-ch");
        assert!(plan[1].via_fallback);
    }

    #[test]
    fn role_route_without_fallback_has_single_target() {
        let plan = plan_route(
            Some((ch("role-ch", 0, 1), "m".into())),
            None, &[], &identity, "x", 1,
        );
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn normal_scheduling_orders_by_priority_then_weight() {
        let normal = vec![ch("low", 0, 1), ch("high", 10, 1), ch("high2", 10, 1)];
        let plan = plan_route(None, None, &normal, &identity, "gpt-4o", 7);
        assert_eq!(plan.len(), 3);
        // 高优先级组(10)整体排在低优先级(0)之前
        assert_eq!(plan[2].channel.id, "low");
        let first_two: Vec<&str> = plan[..2].iter().map(|t| t.channel.id.as_str()).collect();
        assert!(first_two.contains(&"high") && first_two.contains(&"high2"));
    }

    #[test]
    fn disabled_channels_excluded() {
        let mut off = ch("off", 100, 1);
        off.enabled = false;
        let plan = plan_route(None, None, &[off, ch("on", 0, 1)], &identity, "m", 1);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].channel.id, "on");
    }

    #[test]
    fn weighted_pick_deterministic_and_weighted() {
        let cands = vec![ch("a", 0, 1), ch("b", 0, 3)];
        // 统计 1000 个不同 seed 的命中分布，b 应显著多于 a
        let mut a = 0;
        let mut b = 0;
        for s in 0..1000u64 {
            match weighted_pick(&cands, s).unwrap().id.as_str() {
                "a" => a += 1,
                _ => b += 1,
            }
        }
        assert!(b > a, "b({}) should exceed a({})", b, a);
    }

    #[test]
    fn empty_when_no_enabled() {
        let plan = plan_route(None, None, &[], &identity, "m", 1);
        assert!(plan.is_empty());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib router::dispatch`
Expected: FAIL —— `dispatch` 未注册 / `plan_route` 未定义。

- [ ] **Step 3: 注册模块**

`src-tauri/src/router/mod.rs` 改为：
```rust
pub mod dispatch;
pub mod role;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib router::dispatch`
Expected: 6 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): 渠道调度器（角色优先/全局兜底/优先级+权重/故障切换候选序列）"
```

---

## Task 4: 渠道级模型映射（router/model_map.rs）

**Files:**
- Create: `src-tauri/src/router/model_map.rs`
- Modify: `src-tauri/src/router/mod.rs`（加 `pub mod model_map;`）
- Modify: `src-tauri/src/db/repository.rs`（加模型映射 CRUD）
- Test: `src-tauri/src/router/model_map.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `db::Db`、`db::models::Channel`（Task 1）
- Produces:
  - `Repository::set_model_map(&self, channel_id:&str, source:&str, target:&str) -> AppResult<()>`
  - `Repository::get_model_map(&self, channel_id:&str) -> AppResult<Vec<(String,String)>>`
  - `resolve_model(maps: &[(String,String)], request_model: &str) -> String` —— 命中返回 target，否则原样返回 request_model

- [ ] **Step 1: 在 repository.rs 增加模型映射 CRUD**

在 `impl Repository` 内追加：
```rust
    pub fn set_model_map(&self, channel_id: &str, source: &str, target: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO channel_model_maps (id,channel_id,source_model,target_model) VALUES (?1,?2,?3,?4)
             ON CONFLICT(channel_id,source_model) DO UPDATE SET target_model=excluded.target_model",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), channel_id, source, target],
        )?;
        Ok(())
    }

    pub fn get_model_map(&self, channel_id: &str) -> AppResult<Vec<(String, String)>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT source_model, target_model FROM channel_model_maps WHERE channel_id=?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![channel_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
```

- [ ] **Step 2: 写 `router/model_map.rs`（含失败测试）**

```rust
/// 命中映射返回 target，否则原样返回 request_model。
pub fn resolve_model(maps: &[(String, String)], request_model: &str) -> String {
    for (src, tgt) in maps {
        if src == request_model {
            return tgt.clone();
        }
    }
    request_model.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repository::Repository;
    use crate::db::Db;
    use crate::router::dispatch::tests_helper_channel;

    #[test]
    fn resolve_hit_and_miss() {
        let maps = vec![
            ("gpt-4o".to_string(), "gpt-4o-2024-08-06".to_string()),
        ];
        assert_eq!(resolve_model(&maps, "gpt-4o"), "gpt-4o-2024-08-06");
        assert_eq!(resolve_model(&maps, "gpt-4o-mini"), "gpt-4o-mini");
    }

    #[test]
    fn model_map_crud_and_resolve() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let ch = tests_helper_channel("c1");
        repo.insert_channel(&ch).unwrap();
        repo.set_model_map("c1", "claude-sonnet-4", "deepseek-v4-flash").unwrap();
        // 覆盖更新
        repo.set_model_map("c1", "claude-sonnet-4", "deepseek-v4-flash-0715").unwrap();
        let maps = repo.get_model_map("c1").unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(resolve_model(&maps, "claude-sonnet-4"), "deepseek-v4-flash-0715");
    }
}
```

- [ ] **Step 3: 提供测试辅助 `tests_helper_channel`，跑测试确认失败**

在 `router/dispatch.rs` 末尾（`impl` 之外、`#[cfg(test)]` 之前）加：
```rust
#[cfg(test)]
pub fn tests_helper_channel(id: &str) -> crate::db::models::Channel {
    crate::db::models::Channel {
        id: id.into(), name: id.into(), provider_type: "openai".into(),
        base_url: "http://x".into(), api_key: "k".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 60,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}
```
`src-tauri/src/router/mod.rs`:
```rust
pub mod dispatch;
pub mod model_map;
pub mod role;
```
Run: `cd src-tauri && cargo test --lib router::model_map`
Expected: 先因模块未注册 FAIL，注册后再跑。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib router::model_map`
Expected: 2 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): 渠道级模型映射（CRUD + resolve_model）"
```

---

## Task 5: 统一内部格式 + Anthropic/OpenAI 协议双向转换

**Files:**
- Create: `src-tauri/src/protocol/mod.rs`
- Create: `src-tauri/src/protocol/types.rs`
- Create: `src-tauri/src/protocol/anthropic.rs`
- Create: `src-tauri/src/protocol/openai.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod protocol;`）
- Test: 各文件内嵌 `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `types::ChatRequest { model: String, messages: Vec<ChatMessage>, max_tokens: Option<u32>, stream: bool, temperature: Option<f32>, tools: Option<serde_json::Value>, extra: serde_json::Map<String,serde_json::Value> }`
  - `types::ChatMessage { role: String, content: serde_json::Value }`（content 保留原始 JSON 以兼容 text/数组块）
  - `types::ChatResponse { id: String, model: String, content: serde_json::Value, stop_reason: Option<String>, input_tokens: u64, output_tokens: u64, raw: serde_json::Value }`
  - `anthropic::request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String>`
  - `anthropic::chat_to_response(chat: &ChatResponse) -> serde_json::Value`（OpenAI→Anthropic 响应壳）
  - `anthropic::chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value`（统一格式→Anthropic 上游请求体）
  - `openai::request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String>`
  - `openai::chat_to_response(chat: &ChatResponse) -> serde_json::Value`
  - `openai::chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value`

**设计定型**：内部统一 OpenAI Chat 语义。Anthropic 的 `system` 提升为一条 `role:"system"` message；`max_tokens` Anthropic 必填、OpenAI 可选，统一为 `Option`。响应转换只构造非流式壳；流式（SSE）在 Task 7/8 按事件透传+转换，不走此处的整包转换。

- [ ] **Step 1: 写 `protocol/types.rs` + `protocol/mod.rs`**

`types.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
    #[serde(default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    pub model: String,
    pub content: serde_json::Value,
    pub stop_reason: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub raw: serde_json::Value,
}
```
`mod.rs`:
```rust
pub mod anthropic;
pub mod openai;
pub mod types;
```

- [ ] **Step 2: 写 `protocol/anthropic.rs`（含失败测试）**

```rust
use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// Anthropic /v1/messages 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages: Vec<ChatMessage> = Vec::new();
    // system 提升为 system message
    if let Some(sys) = v.get("system") {
        let content = match sys {
            serde_json::Value::String(s) => serde_json::Value::String(s.clone()),
            other => other.clone(),
        };
        messages.push(ChatMessage { role: "system".into(), content });
    }
    if let Some(arr) = v.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string();
            let content = m.get("content").cloned().unwrap_or(serde_json::Value::Null);
            messages.push(ChatMessage { role, content });
        }
    }
    let max_tokens = v.get("max_tokens").and_then(|t| t.as_u64()).map(|t| t as u32);
    let stream = v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let temperature = v.get("temperature").and_then(|t| t.as_f64()).map(|t| t as f32);
    let tools = v.get("tools").cloned();
    Ok(ChatRequest {
        model, messages, max_tokens, stream, temperature, tools,
        extra: Default::default(),
    })
}

/// 统一 ChatRequest → Anthropic 上游请求体（发往 Anthropic 渠道时）。
pub fn chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value {
    let mut system = serde_json::Value::Null;
    let mut messages = Vec::new();
    for m in &chat.messages {
        if m.role == "system" {
            system = m.content.clone();
        } else {
            messages.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": chat.max_tokens.unwrap_or(4096),
        "stream": chat.stream,
    });
    if !system.is_null() {
        body["system"] = system;
    }
    if let Some(t) = chat.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = &chat.tools {
        body["tools"] = tools.clone();
    }
    body
}

/// 统一 ChatResponse → Anthropic 响应壳。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    serde_json::json!({
        "id": chat.id,
        "type": "message",
        "role": "assistant",
        "model": chat.model,
        "content": chat.content,
        "stop_reason": chat.stop_reason,
        "usage": { "input_tokens": chat.input_tokens, "output_tokens": chat.output_tokens }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_req_to_chat_lifts_system() {
        let v = serde_json::json!({
            "model": "claude-sonnet-4", "max_tokens": 1024, "stream": true,
            "system": "you are helpful",
            "messages": [{"role":"user","content":"hi"}]
        });
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "claude-sonnet-4");
        assert_eq!(chat.max_tokens, Some(1024));
        assert!(chat.stream);
        assert_eq!(chat.messages[0].role, "system");
        assert_eq!(chat.messages[1].role, "user");
    }

    #[test]
    fn chat_to_anthropic_upstream_restores_system() {
        let v = serde_json::json!({
            "model": "claude-sonnet-4", "max_tokens": 100,
            "system": "sys", "messages": [{"role":"user","content":"hi"}]
        });
        let chat = request_to_chat(&v).unwrap();
        let up = chat_request_to_upstream(&chat, "claude-sonnet-4-20250514");
        assert_eq!(up["model"], "claude-sonnet-4-20250514");
        assert_eq!(up["system"], "sys");
        assert_eq!(up["max_tokens"], 100);
        assert_eq!(up["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn missing_model_errors() {
        let v = serde_json::json!({"messages": []});
        assert!(request_to_chat(&v).is_err());
    }
}
```

- [ ] **Step 3: 写 `protocol/openai.rs`（含失败测试）**

```rust
use super::types::{ChatMessage, ChatRequest, ChatResponse};

/// OpenAI /v1/chat/completions 请求体 → 统一 ChatRequest。
pub fn request_to_chat(v: &serde_json::Value) -> Result<ChatRequest, String> {
    let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
    if model.is_empty() {
        return Err("missing model".into());
    }
    let mut messages = Vec::new();
    if let Some(arr) = v.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            messages.push(ChatMessage {
                role: m.get("role").and_then(|r| r.as_str()).unwrap_or("user").to_string(),
                content: m.get("content").cloned().unwrap_or(serde_json::Value::Null),
            });
        }
    }
    Ok(ChatRequest {
        model,
        messages,
        max_tokens: v.get("max_tokens").and_then(|t| t.as_u64()).map(|t| t as u32),
        stream: v.get("stream").and_then(|s| s.as_bool()).unwrap_or(false),
        temperature: v.get("temperature").and_then(|t| t.as_f64()).map(|t| t as f32),
        tools: v.get("tools").cloned(),
        extra: Default::default(),
    })
}

/// 统一 ChatRequest → OpenAI 上游请求体。
pub fn chat_request_to_upstream(chat: &ChatRequest, model: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": chat.messages,
        "stream": chat.stream,
    });
    if let Some(t) = chat.max_tokens {
        body["max_tokens"] = serde_json::json!(t);
    }
    if let Some(t) = chat.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(tools) = &chat.tools {
        body["tools"] = tools.clone();
    }
    body
}

/// 统一 ChatResponse → OpenAI 响应壳。
pub fn chat_to_response(chat: &ChatResponse) -> serde_json::Value {
    serde_json::json!({
        "id": chat.id,
        "object": "chat.completion",
        "model": chat.model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": chat.content },
            "finish_reason": chat.stop_reason
        }],
        "usage": {
            "prompt_tokens": chat.input_tokens,
            "completion_tokens": chat.output_tokens,
            "total_tokens": chat.input_tokens + chat.output_tokens
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_req_roundtrip() {
        let v = serde_json::json!({
            "model": "gpt-4o", "stream": true,
            "messages": [{"role":"user","content":"hello"}]
        });
        let chat = request_to_chat(&v).unwrap();
        assert_eq!(chat.model, "gpt-4o");
        assert!(chat.stream);
        let up = chat_request_to_upstream(&chat, "gpt-4o-2024-08-06");
        assert_eq!(up["model"], "gpt-4o-2024-08-06");
        assert_eq!(up["stream"], true);
    }
}
```

- [ ] **Step 4: 注册模块，跑测试确认通过**

`src-tauri/src/lib.rs` 顶部加 `pub mod protocol;`
Run: `cd src-tauri && cargo test --lib protocol`
Expected: anthropic 3 个 + openai 1 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): 统一内部格式 + Anthropic/OpenAI 协议双向转换"
```

---

## Task 6: 密钥鉴权 + 配额（auth.rs）

**Files:**
- Create: `src-tauri/src/auth.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod auth;`）
- Modify: `src-tauri/src/db/repository.rs`（加配额/统计更新方法）
- Test: `src-tauri/src/auth.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Consumes: `db::repository::Repository`、`db::models::ApiKey`（Task 1）
- Produces:
  - `AuthError { Invalid, Disabled, QuotaExceeded }`（`thiserror`，Display 分别为 `invalid_api_key` / `api_key_disabled` / `quota_exceeded`）
  - `authorize(repo: &Repository, key: &str) -> Result<ApiKey, AuthError>` —— 校验存在/启用/配额未超
  - `generate_key() -> String` —— 返回 `sk-lgw-<32位hex>`
  - `Repository::consume_quota(&self, key_id:&str, tokens:i64) -> AppResult<()>` —— quota_used/total_tokens/total_calls/last_used_at 累加
  - `Repository::record_channel_stats(&self, channel_id:&str, tokens:i64, latency_ms:i64, success:bool) -> AppResult<()>`

- [ ] **Step 1: 在 repository.rs 追加统计/配额方法**

```rust
    pub fn consume_quota(&self, key_id: &str, tokens: i64) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "UPDATE api_keys SET quota_used=quota_used+?1, total_tokens=total_tokens+?1,
             total_calls=total_calls+1, last_used_at=?2 WHERE id=?3",
            rusqlite::params![tokens, chrono::Utc::now().timestamp(), key_id],
        )?;
        Ok(())
    }

    pub fn record_channel_stats(&self, channel_id: &str, tokens: i64, latency_ms: i64, success: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        // 简化：累计调用与 token，平均延迟用滑动近似，success_rate 用指数滑动
        conn.execute(
            "UPDATE channels SET total_calls=total_calls+1, total_tokens=total_tokens+?1,
             avg_latency_ms = CASE WHEN total_calls=0 THEN ?2 ELSE (avg_latency_ms*total_calls + ?2)/(total_calls+1) END,
             success_rate = success_rate*0.9 + ?3*0.1
             WHERE id=?4",
            rusqlite::params![tokens, latency_ms, if success {1.0} else {0.0}, channel_id],
        )?;
        Ok(())
    }
```

- [ ] **Step 2: 写 `auth.rs`（含失败测试）**

```rust
use crate::db::models::ApiKey;
use crate::db::repository::Repository;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum AuthError {
    #[error("invalid_api_key")]
    Invalid,
    #[error("api_key_disabled")]
    Disabled,
    #[error("quota_exceeded")]
    QuotaExceeded,
}

/// 校验密钥：存在 → 启用 → 配额未超。返回密钥记录供后续路由/日志使用。
pub fn authorize(repo: &Repository, key: &str) -> Result<ApiKey, AuthError> {
    let k = repo.get_api_key_by_key(key).map_err(|_| AuthError::Invalid)?;
    let k = match k {
        Some(k) => k,
        None => return Err(AuthError::Invalid),
    };
    if !k.enabled {
        return Err(AuthError::Disabled);
    }
    if let Some(total) = k.quota_total {
        if k.quota_used >= total {
            return Err(AuthError::QuotaExceeded);
        }
    }
    Ok(k)
}

/// 生成本地密钥：sk-lgw-<32 hex>
pub fn generate_key() -> String {
    let hex: String = uuid::Uuid::new_v4().simple().to_string();
    format!("sk-lgw-{}", hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn repo_with_key(k: &ApiKey) -> Repository {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_api_key(k).unwrap();
        repo
    }

    fn base_key() -> ApiKey {
        ApiKey {
            id: "k1".into(), key: "sk-lgw-x".into(), name: "a".into(), enabled: true,
            quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
            created_at: 1, last_used_at: None,
        }
    }

    #[test]
    fn generate_key_format() {
        let k = generate_key();
        assert!(k.starts_with("sk-lgw-"));
        assert_eq!(k.len(), "sk-lgw-".len() + 32);
    }

    #[test]
    fn authorize_happy_and_unlimited_quota() {
        let repo = repo_with_key(&base_key());
        assert!(authorize(&repo, "sk-lgw-x").is_ok());
    }

    #[test]
    fn authorize_invalid() {
        let repo = repo_with_key(&base_key());
        assert_eq!(authorize(&repo, "nope").unwrap_err(), AuthError::Invalid);
    }

    #[test]
    fn authorize_disabled() {
        let mut k = base_key();
        k.enabled = false;
        let repo = repo_with_key(&k);
        assert_eq!(authorize(&repo, "sk-lgw-x").unwrap_err(), AuthError::Disabled);
    }

    #[test]
    fn authorize_quota_exceeded() {
        let mut k = base_key();
        k.quota_total = Some(100);
        k.quota_used = 100;
        let repo = repo_with_key(&k);
        assert_eq!(authorize(&repo, "sk-lgw-x").unwrap_err(), AuthError::QuotaExceeded);
        // 未超额则通过
        let mut k2 = base_key();
        k2.quota_total = Some(100);
        k2.quota_used = 50;
        let repo2 = repo_with_key(&k2);
        assert!(authorize(&repo2, "sk-lgw-x").is_ok());
    }

    #[test]
    fn consume_quota_accumulates() {
        let repo = repo_with_key(&base_key());
        repo.consume_quota("k1", 30).unwrap();
        repo.consume_quota("k1", 20).unwrap();
        let got = repo.get_api_key_by_key("sk-lgw-x").unwrap().unwrap();
        assert_eq!(got.quota_used, 50);
        assert_eq!(got.total_calls, 2);
        assert!(got.last_used_at.is_some());
    }
}
```

- [ ] **Step 3: 注册模块，跑测试确认通过**

`src-tauri/src/lib.rs` 顶部加 `pub mod auth;`
Run: `cd src-tauri && cargo test --lib auth`
Expected: 6 个测试全 PASS。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(stage1): 密钥鉴权 + 配额检查/扣减 + 渠道统计"
```

---

## Task 7: SSE 流式解析 + usage 累积（proxy/sse.rs）

**Files:**
- Create: `src-tauri/src/proxy/mod.rs`
- Create: `src-tauri/src/proxy/sse.rs`
- Modify: `src-tauri/src/lib.rs`（加 `pub mod proxy;`）
- Test: `src-tauri/src/proxy/sse.rs`（内嵌 `#[cfg(test)]`）

**Interfaces:**
- Produces:
  - `Usage { input_tokens: u64, output_tokens: u64 }`
  - `SseAccumulator::new() -> Self`
  - `SseAccumulator::feed_line(&mut self, line: &str)` —— 解析一行 SSE，累积 usage（OpenAI `usage` 字段 与 Anthropic `message_start`/`message_delta` 的 usage）
  - `SseAccumulator::usage(&self) -> Usage`
  - `extract_openai_usage(v:&serde_json::Value) -> Option<Usage>`
  - `apply_anthropic_event(acc:&mut Usage, v:&serde_json::Value)`

**设计定型**：流式响应里 Token 统计来源两种协议不同。OpenAI 在末尾 chunk（`stream_options.include_usage` 或最后 `usage` 字段）；Anthropic 在 `message_start`（input_tokens）与 `message_delta`（output_tokens 增量）。本任务只做解析与累积，与转发解耦，便于单测。

- [ ] **Step 1: 写 `proxy/mod.rs` + `proxy/sse.rs`（含失败测试）**

`proxy/mod.rs`:
```rust
pub mod sse;
```

`proxy/sse.rs`:
```rust
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// 从 OpenAI chunk 的 usage 字段提取（若存在）。
pub fn extract_openai_usage(v: &serde_json::Value) -> Option<Usage> {
    let u = v.get("usage")?;
    if u.is_null() {
        return None;
    }
    let input = u.get("prompt_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
    let output = u.get("completion_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage { input_tokens: input, output_tokens: output })
}

/// 应用一条 Anthropic SSE 事件到 usage 累积。
pub fn apply_anthropic_event(acc: &mut Usage, v: &serde_json::Value) {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("message_start") => {
            if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                if let Some(i) = u.get("input_tokens").and_then(|t| t.as_u64()) {
                    acc.input_tokens = i;
                }
                if let Some(o) = u.get("output_tokens").and_then(|t| t.as_u64()) {
                    acc.output_tokens = o;
                }
            }
        }
        Some("message_delta") => {
            if let Some(u) = v.get("usage") {
                if let Some(o) = u.get("output_tokens").and_then(|t| t.as_u64()) {
                    acc.output_tokens = o; // Anthropic 在 delta 里给累计值
                }
            }
        }
        _ => {}
    }
}

/// 逐行解析 SSE，按协议累积 usage。
pub struct SseAccumulator {
    usage: Usage,
    protocol: Protocol,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Protocol {
    OpenAI,
    Anthropic,
}

impl SseAccumulator {
    pub fn new(protocol: Protocol) -> Self {
        Self { usage: Usage::default(), protocol }
    }

    /// 喂入一行原始 SSE 文本（可能是 "data: {...}" 或空行/event 行）。
    pub fn feed_line(&mut self, line: &str) {
        let line = line.trim();
        if !line.starts_with("data:") {
            return;
        }
        let payload = line.trim_start_matches("data:").trim();
        if payload == "[DONE]" || payload.is_empty() {
            return;
        }
        let v: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return,
        };
        match self.protocol {
            Protocol::OpenAI => {
                if let Some(u) = extract_openai_usage(&v) {
                    self.usage = u;
                }
            }
            Protocol::Anthropic => apply_anthropic_event(&mut self.usage, &v),
        }
    }

    pub fn usage(&self) -> Usage {
        self.usage
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_usage_from_final_chunk() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line(r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#);
        acc.feed_line(r#"data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#);
        acc.feed_line("data: [DONE]");
        let u = acc.usage();
        assert_eq!(u.input_tokens, 10);
        assert_eq!(u.output_tokens, 5);
    }

    #[test]
    fn anthropic_usage_across_events() {
        let mut acc = SseAccumulator::new(Protocol::Anthropic);
        acc.feed_line(r#"data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#);
        acc.feed_line(r#"data: {"type":"content_block_delta","delta":{"text":"hello"}}"#);
        acc.feed_line(r#"data: {"type":"message_delta","usage":{"output_tokens":12}}"#);
        let u = acc.usage();
        assert_eq!(u.input_tokens, 25);
        assert_eq!(u.output_tokens, 12);
    }

    #[test]
    fn ignores_non_data_and_garbage() {
        let mut acc = SseAccumulator::new(Protocol::OpenAI);
        acc.feed_line("event: message_start");
        acc.feed_line("");
        acc.feed_line("data: not-json");
        assert_eq!(acc.usage(), Usage::default());
    }
}
```

- [ ] **Step 2: 注册模块，跑测试确认通过**

`src-tauri/src/lib.rs` 顶部加 `pub mod proxy;`
Run: `cd src-tauri && cargo test --lib proxy::sse`
Expected: 3 个测试全 PASS。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(stage1): SSE 流式解析 + 双协议 Token usage 累积"
```

---

## Task 8: 转发器 forwarder —— 依候选序列转发 + 重试/兜底 + SSE 透传

**Files:**
- Create: `src-tauri/src/proxy/forwarder.rs`
- Create: `src-tauri/src/proxy/state.rs`
- Create: `src-tauri/src/provider/mod.rs`
- Create: `src-tauri/src/provider/adapter.rs`
- Modify: `src-tauri/src/proxy/mod.rs`（加 `pub mod forwarder; pub mod state;`）、`src-tauri/src/lib.rs`（加 `pub mod provider;`）
- Test: `tests/common/mod.rs`、`tests/forward_failover.rs`

**Interfaces:**
- Consumes: `router::dispatch::{plan_route, RouteTarget}`、`router::role::detect_role`、`router::model_map::resolve_model`、`auth::authorize`、`protocol::*`、`proxy::sse::SseAccumulator`、repository 全部方法
- Produces:
  - `state::AppState { db: Db, repo: Repository, http: reqwest::Client, fallback: Arc<RwLock<Option<(String,String)>>>, retry_count: usize }`（fallback 存 channel_id+model）
  - `provider::adapter::build_upstream_body(chat: &ChatRequest, provider_type: &str, model: &str) -> serde_json::Value`（按渠道类型转换出站请求体）
  - `provider::adapter::upstream_url(provider_type: &str, base_url: &str, stream: bool) -> String`
  - `forwarder::Outcome { status: u16, body: serde_json::Value, usage: Usage, channel: Channel, model: String, via_fallback: bool }`（非流式）
  - `forwarder::forward(state: &AppState, chat: &ChatRequest, role: Option<String>, api_key: &ApiKey) -> Result<ForwardResult, GatewayError>` —— 编排：plan_route → 依序尝试 → 成功即返回 / 记录日志
  - `GatewayError { NoChannel, Upstream{status,body}, ... }`

**设计定型**：本任务是管线核心编排。它把 Task 2–7 的零件串起来。集成测试用 mock 上游（axum 起临时 server）验证：角色命中走绑定渠道、绑定渠道 5xx 自动落兜底、4xx 不透传兜底直接返回、Token 入库。流式路径本任务先实现「读完整流再回传」的简化版，真正逐 chunk 透传在 Task 9 handler 里做（forwarder 提供非流式 + 收集式流式两种）。

- [ ] **Step 1: 写 `provider/mod.rs` 与 `provider/adapter.rs`（出站适配）**

`provider/mod.rs`:
```rust
pub mod adapter;
```

`provider/adapter.rs`:
```rust
use crate::protocol::types::ChatRequest;

/// 统一格式 → 指定渠道类型的上游请求体。
pub fn build_upstream_body(chat: &ChatRequest, provider_type: &str, model: &str) -> serde_json::Value {
    match provider_type {
        "claude" | "anthropic" => crate::protocol::anthropic::chat_request_to_upstream(chat, model),
        // openai / deepseek / gemini(openai-compat) / custom 默认走 OpenAI 格式
        _ => crate::protocol::openai::chat_request_to_upstream(chat, model),
    }
}

/// 上游完整 URL。
pub fn upstream_url(provider_type: &str, base_url: &str, _stream: bool) -> String {
    let base = base_url.trim_end_matches('/');
    match provider_type {
        "claude" | "anthropic" => format!("{}/v1/messages", base),
        "gemini" => format!("{}/v1/chat/completions", base), // gemini openai-compat 端点
        _ => format!("{}/v1/chat/completions", base),
    }
}

/// 上游鉴权头：返回 (header名, 值前缀)。Anthropic 用 x-api-key，其余用 Bearer。
pub fn auth_header(provider_type: &str, api_key: &str) -> (String, String) {
    match provider_type {
        "claude" | "anthropic" => ("x-api-key".to_string(), api_key.to_string()),
        _ => ("authorization".to_string(), format!("Bearer {}", api_key)),
    }
}
```

`src-tauri/src/lib.rs` 顶部加 `pub mod provider;`

- [ ] **Step 2: 写 `proxy/state.rs`**

```rust
use crate::db::repository::Repository;
use crate::db::Db;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub repo: Repository,
    pub http: reqwest::Client,
    /// 全局兜底：(channel_id, model)
    pub fallback: Arc<RwLock<Option<(String, String)>>>,
    pub retry_count: usize,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let repo = Repository::new(db.clone());
        Self {
            db,
            repo,
            http: reqwest::Client::new(),
            fallback: Arc::new(RwLock::new(None)),
            retry_count: 2,
        }
    }
}
```
`proxy/mod.rs`:
```rust
pub mod forwarder;
pub mod sse;
pub mod state;
```

- [ ] **Step 3: 写 forwarder 失败测试（集成，mock 上游）**

`tests/common/mod.rs`:
```rust
use axum::{extract::State, routing::post, Json, Router};
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct MockUpstream {
    pub hits: Arc<Mutex<Vec<Value>>>,
    pub respond_status: Arc<Mutex<u16>>,
    pub respond_body: Arc<Mutex<Value>>,
}

/// 起一个返回固定响应的 mock /v1/chat/completions + /v1/messages，返回 base_url。
pub async fn spawn_mock(status: u16, body: Value) -> (String, MockUpstream) {
    let state = MockUpstream {
        hits: Arc::new(Mutex::new(vec![])),
        respond_status: Arc::new(Mutex::new(status)),
        respond_body: Arc::new(Mutex::new(body)),
    };
    let s = state.clone();
    let app = Router::new()
        .route("/v1/chat/completions", post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
            let s = st.0.clone();
            async move {
                s.hits.lock().unwrap().push(v);
                let status = *s.respond_status.lock().unwrap();
                let body = s.respond_body.lock().unwrap().clone();
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(body))
            }
        }))
        .route("/v1/messages", post(move |st: State<MockUpstream>, Json(v): Json<Value>| {
            let s = st.0.clone();
            async move {
                s.hits.lock().unwrap().push(v);
                let status = *s.respond_status.lock().unwrap();
                let body = s.respond_body.lock().unwrap().clone();
                (axum::http::StatusCode::from_u16(status).unwrap(), Json(body))
            }
        }))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{}", addr), state)
}
```

`tests/forward_failover.rs`:
```rust
mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::protocol::openai;
use llm_gateway_lib::proxy::forwarder::{forward, ForwardError};
use llm_gateway_lib::proxy::state::AppState;

fn channel(id: &str, base: &str, ptype: &str) -> Channel {
    Channel {
        id: id.into(), name: id.into(), provider_type: ptype.into(),
        base_url: base.into(), api_key: "sk-real".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 5,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}

fn key(id: &str) -> ApiKey {
    ApiKey {
        id: id.into(), key: format!("sk-lgw-{}", id), name: id.into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }
}

fn ok_openai_body() -> serde_json::Value {
    serde_json::json!({
        "id":"chatcmpl-1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
    })
}

fn chat() -> llm_gateway_lib::protocol::types::ChatRequest {
    openai::request_to_chat(&serde_json::json!({
        "model":"gpt-4o","messages":[{"role":"user","content":"hi"}]
    }))
    .unwrap()
}

#[tokio::test]
async fn role_route_hits_bound_channel() {
    let (base, mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", &base, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some(("c1".into(), "deepseek-v4-flash".into())), &ak).await.unwrap();
    assert_eq!(res.outcome.channel.id, "c1");
    assert!(!res.outcome.via_fallback);
    // 上游收到的 model 是映射后的
    let hit = mock.hits.lock().unwrap()[0].clone();
    assert_eq!(hit["model"], "deepseek-v4-flash");
}

#[tokio::test]
async fn role_channel_5xx_falls_back() {
    let (bad, _) = common::spawn_mock(500, serde_json::json!({"error":"boom"})).await;
    let (good, good_mock) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("role-ch", &bad, "openai")).unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    *state.fallback.write().unwrap() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let res = forward(&state, &chat(), Some(("role-ch".into(), "m1".into())), &ak).await.unwrap();
    assert_eq!(res.outcome.channel.id, "fb-ch");
    assert!(res.outcome.via_fallback);
    assert!(!good_mock.hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn role_4xx_does_not_fallback() {
    let (bad, _) = common::spawn_mock(400, serde_json::json!({"error":"bad request"})).await;
    let (good, _) = common::spawn_mock(200, ok_openai_body()).await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("role-ch", &bad, "openai")).unwrap();
    repo.insert_channel(&channel("fb-ch", &good, "openai")).unwrap();
    repo.insert_api_key(&key("k1")).unwrap();
    let state = AppState::new(db);
    *state.fallback.write().unwrap() = Some(("fb-ch".into(), "kimi-k3".into()));
    let ak = repo.get_api_key_by_key("sk-lgw-k1").unwrap().unwrap();
    let err = forward(&state, &chat(), Some(("role-ch".into(), "m1".into())), &ak).await.unwrap_err();
    match err {
        ForwardError::Upstream { status, .. } => assert_eq!(status, 400),
        other => panic!("expected Upstream 400, got {:?}", other),
    }
}
```

- [ ] **Step 4: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test forward_failover`
Expected: FAIL —— `forwarder::forward`、`ForwardResult`、`ForwardError` 未定义。

- [ ] **Step 5: 实现 `proxy/forwarder.rs`（非流式 + 收集式流式）**

```rust
use crate::db::models::{ApiKey, Channel};
use crate::protocol::types::ChatRequest;
use crate::provider::adapter::{auth_header, build_upstream_body, upstream_url};
use crate::proxy::sse::{Protocol, SseAccumulator, Usage};
use crate::proxy::state::AppState;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct Outcome {
    pub status: u16,
    pub body: serde_json::Value,
    pub usage: Usage,
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
    pub latency_ms: i64,
}

#[derive(Debug)]
pub struct ForwardResult {
    pub outcome: Outcome,
    pub role: Option<String>,
}

#[derive(Debug, Error)]
pub enum ForwardError {
    #[error("no_available_channel")]
    NoChannel,
    #[error("upstream_unavailable: status={status} body={body}")]
    Upstream { status: u16, body: String },
    #[error("http: {0}")]
    Http(String),
}

/// 判断该状态码是否触发切换/兜底。
fn is_failover_status(status: u16) -> bool {
    status == 429 || status == 401 || status == 403 || status >= 500
}

/// 编排一次转发。
/// role_route: Some((channel_id, target_model)) 表示已识别角色并有绑定。
pub async fn forward(
    state: &AppState,
    chat: &ChatRequest,
    role_route: Option<(String, String)>,
    _api_key: &ApiKey,
) -> Result<ForwardResult, ForwardError> {
    // 组装候选序列
    let all = state.repo.list_channels().map_err(|e| ForwardError::Http(e.to_string()))?;
    let by_id = |id: &str| all.iter().find(|c| c.id == id).cloned();

    let mut candidates: Vec<(Channel, String, bool)> = Vec::new(); // (channel, model, via_fallback)
    if let Some((cid, model)) = &role_route {
        if let Some(ch) = by_id(cid) {
            candidates.push((ch, model.clone(), false));
        }
        if let Some((fid, fmodel)) = state.fallback.read().unwrap().clone() {
            if let Some(fch) = by_id(&fid) {
                candidates.push((fch, fmodel, true));
            }
        }
    } else {
        // 普通调度：复用 dispatch 排序
        let maps_fn = |c: &Channel, m: &str| {
            let maps = state.repo.get_model_map(&c.id).unwrap_or_default();
            crate::router::model_map::resolve_model(&maps, m)
        };
        let plan = crate::router::dispatch::plan_route(
            None, None, &all, &maps_fn, &chat.model, 1,
        );
        for t in plan {
            candidates.push((t.channel, t.model, t.via_fallback));
        }
    }

    if candidates.is_empty() {
        return Err(ForwardError::NoChannel);
    }

    let max = if role_route.is_some() { candidates.len() } else { (state.retry_count + 1).min(candidates.len()) };
    let mut last_err: Option<ForwardError> = None;
    for (ch, model, via_fallback) in candidates.into_iter().take(max) {
        let start = std::time::Instant::now();
        match try_channel(state, &ch, &model, chat).await {
            Ok((status, body, usage)) => {
                let latency = start.elapsed().as_millis() as i64;
                let _ = state.repo.record_channel_stats(&ch.id, (usage.input_tokens + usage.output_tokens) as i64, latency, true);
                return Ok(ForwardResult {
                    outcome: Outcome { status, body, usage, channel: ch, model, via_fallback, latency_ms: latency },
                    role: None,
                });
            }
            Err(e) => {
                let latency = start.elapsed().as_millis() as i64;
                let _ = state.repo.record_channel_stats(&ch.id, 0, latency, false);
                // 4xx 非 failover：直接返回，不继续
                if let ForwardError::Upstream { status, .. } = &e {
                    if !is_failover_status(*status) {
                        return Err(e);
                    }
                }
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or(ForwardError::NoChannel))
}

async fn try_channel(
    state: &AppState,
    ch: &Channel,
    model: &str,
    chat: &ChatRequest,
) -> Result<(u16, serde_json::Value, Usage), ForwardError> {
    let url = upstream_url(&ch.provider_type, &ch.base_url, chat.stream);
    let body = build_upstream_body(chat, &ch.provider_type, model);
    let (hname, hval) = auth_header(&ch.provider_type, &ch.api_key);
    let resp = state
        .http
        .post(&url)
        .header(hname, hval)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64))
        .json(&body)
        .send()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| ForwardError::Http(e.to_string()))?;
    if status != 200 {
        return Err(ForwardError::Upstream { status, body: text });
    }
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({"raw": text}));
    // 非流式：直接从 body 提取 usage
    let usage = if ch.provider_type == "claude" || ch.provider_type == "anthropic" {
        let mut acc = SseAccumulator::new(Protocol::Anthropic);
        let u = v.get("usage").cloned().unwrap_or(serde_json::json!({}));
        let mut us = Usage::default();
        us.input_tokens = u.get("input_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
        us.output_tokens = u.get("output_tokens").and_then(|t| t.as_u64()).unwrap_or(0);
        let _ = acc; us
    } else {
        crate::proxy::sse::extract_openai_usage(&v).unwrap_or_default()
    };
    Ok((status, v, usage))
}
```

> forward 签名里 `_api_key` 保留用于后续按 key 维度限流扩展。

- [ ] **Step 6: 跑集成测试确认通过**

Run: `cd src-tauri && cargo test --test forward_failover`
Expected: 3 个测试全 PASS（角色命中、5xx 兜底、4xx 不兜底）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(stage1): 转发器——候选序列转发 + 重试/兜底 + 4xx不透传 + 出站协议适配"
```

---

## Task 9: axum 网关 server + handlers（对外端点 + 全管线编排 + SSE）

**Files:**
- Create: `src-tauri/src/proxy/server.rs`
- Create: `src-tauri/src/proxy/handlers.rs`
- Modify: `src-tauri/src/proxy/mod.rs`（加 `pub mod server; pub mod handlers;`）
- Modify: `src-tauri/src/db/repository.rs`（加 `insert_log`、`next_log_seq`、role_route/role_pattern/fallback 读取方法）
- Test: `tests/gateway_e2e.rs`

**Interfaces:**
- Consumes: 全部前面任务
- Produces:
  - `server::start(state: AppState, port: u16) -> tokio::task::JoinHandle<()>`
  - `Repository::insert_log(&self, log:&RequestLog) -> AppResult<()>`
  - `Repository::next_log_seq(&self) -> AppResult<i64>`
  - `Repository::get_role_route(&self, role:&str) -> AppResult<Option<RoleRoute>>`
  - `Repository::list_role_patterns(&self) -> AppResult<Vec<RolePattern>>`
  - handlers：`anthropic_messages`、`openai_chat`、`list_models`、`health`

**编排（handlers 内）**：鉴权 → detect_role → get_role_route → forward → 写日志（role/request_model/upstream_model/fallback/status/usage/latency/body）→ consume_quota → 按入站协议转换响应回传。流式请求本任务以「收集完整响应后按对应协议 SSE 格式一次性回传」实现最小可用，逐 chunk 实时透传作为后续增强（在计划中标注）。

- [ ] **Step 1: 在 repository.rs 追加日志与角色路由读取方法**

```rust
    pub fn next_log_seq(&self) -> AppResult<i64> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM request_logs", [], |r| r.get(0))?;
        Ok(n)
    }

    pub fn insert_log(&self, l: &crate::db::models::RequestLog) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO request_logs (id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            rusqlite::params![
                l.id,l.seq,l.trace_id,l.api_key_id,l.key_name,l.channel_id,l.channel_name,
                l.role,l.request_model,l.upstream_model,l.protocol,l.status_code,
                l.input_tokens,l.output_tokens,l.latency_ms,l.is_stream as i64,l.error,
                l.fallback as i64,l.tool_calls,l.request_body,l.response_body,l.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_role_route(&self, role: &str) -> AppResult<Option<crate::db::models::RoleRoute>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,role,channel_id,target_model,enabled,updated_at FROM role_routes WHERE role=?1 AND enabled=1",
        )?;
        let mut rows = stmt.query(rusqlite::params![role])?;
        if let Some(r) = rows.next()? {
            Ok(Some(crate::db::models::RoleRoute {
                id: r.get(0)?, role: r.get(1)?, channel_id: r.get(2)?,
                target_model: r.get(3)?, enabled: r.get::<_, i64>(4)? != 0, updated_at: r.get(5)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_role_patterns(&self) -> AppResult<Vec<crate::db::models::RolePattern>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,pattern,role,priority,enabled FROM role_patterns ORDER BY priority DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::db::models::RolePattern {
                id: r.get(0)?, pattern: r.get(1)?, role: r.get(2)?,
                priority: r.get(3)?, enabled: r.get::<_, i64>(4)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }
```

- [ ] **Step 2: 写端到端失败测试 `tests/gateway_e2e.rs`**

```rust
mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(), name: id.into(), provider_type: "openai".into(),
        base_url: base.into(), api_key: "sk-real".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 5,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}

#[tokio::test]
async fn end_to_end_openai_with_role_route_and_logging() {
    let (base, _mock) = common::spawn_mock(200, serde_json::json!({
        "id":"c1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
    })).await;

    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", &base)).unwrap();
    repo.insert_api_key(&ApiKey {
        id: "k1".into(), key: "sk-lgw-test".into(), name: "t".into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }).unwrap();
    // 角色路由：sonnet → c1/deepseek-v4-flash
    repo.upsert_role_route(&RoleRoute {
        id: "r1".into(), role: "sonnet".into(), channel_id: "c1".into(),
        target_model: "deepseek-v4-flash".into(), enabled: true, updated_at: 1,
    }).unwrap();

    let state = AppState::new(db);
    let _h = server::start(state.clone(), 0).await; // 0 = 随机端口，需 server 返回实际地址
    let addr = server::bound_addr().unwrap();

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4-20250514",
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let v: serde_json::Value = resp.json().await.unwrap();
    assert!(v["choices"].is_array());

    // 日志已入库，role/upstream_model 正确
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.role.as_deref(), Some("sonnet"));
    assert_eq!(log.request_model.as_deref(), Some("claude-sonnet-4-20250514"));
    assert_eq!(log.upstream_model.as_deref(), Some("deepseek-v4-flash"));
    assert_eq!(log.input_tokens, 10);
    // 配额已扣
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 15);
}

#[tokio::test]
async fn invalid_key_rejected_401() {
    let db = Db::new_in_memory().unwrap();
    let state = AppState::new(db);
    let _h = server::start(state, 0).await;
    let addr = server::bound_addr().unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer wrong")
        .json(&serde_json::json!({"model":"x","messages":[]}))
        .send().await.unwrap();
    assert_eq!(resp.status(), 401);
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test gateway_e2e`
Expected: FAIL —— `server::start`、`upsert_role_route`、`latest_log` 未定义。

- [ ] **Step 4: 实现 repository 的 `upsert_role_route`/`latest_log` + `proxy/server.rs` + `proxy/handlers.rs`**

repository 追加：
```rust
    pub fn upsert_role_route(&self, r: &crate::db::models::RoleRoute) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO role_routes (id,role,channel_id,target_model,enabled,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(role) DO UPDATE SET channel_id=excluded.channel_id, target_model=excluded.target_model, enabled=excluded.enabled, updated_at=excluded.updated_at",
            rusqlite::params![r.id, r.role, r.channel_id, r.target_model, r.enabled as i64, r.updated_at],
        )?;
        Ok(())
    }

    pub fn latest_log(&self) -> AppResult<Option<crate::db::models::RequestLog>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,created_at FROM request_logs ORDER BY seq DESC LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(r) = rows.next()? {
            Ok(Some(crate::db::models::RequestLog {
                id: r.get(0)?, seq: r.get(1)?, trace_id: r.get(2)?,
                api_key_id: r.get(3)?, key_name: r.get(4)?, channel_id: r.get(5)?,
                channel_name: r.get(6)?, role: r.get(7)?, request_model: r.get(8)?,
                upstream_model: r.get(9)?, protocol: r.get(10)?, status_code: r.get(11)?,
                input_tokens: r.get(12)?, output_tokens: r.get(13)?, latency_ms: r.get(14)?,
                is_stream: r.get::<_, i64>(15)? != 0, error: r.get(16)?,
                fallback: r.get::<_, i64>(17)? != 0, tool_calls: r.get(18)?,
                request_body: r.get(19)?, response_body: r.get(20)?, created_at: r.get(21)?,
            }))
        } else {
            Ok(None)
        }
    }
```

`proxy/server.rs`（记录绑定地址到全局，供测试与运行查询）：
```rust
use crate::proxy::handlers;
use crate::proxy::state::AppState;
use axum::{routing::{get, post}, Router};
use std::net::SocketAddr;
use std::sync::OnceLock;

static BOUND: OnceLock<SocketAddr> = OnceLock::new();

pub fn bound_addr() -> Option<SocketAddr> {
    BOUND.get().copied()
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(handlers::health))
        .route("/v1/models", get(handlers::list_models))
        .route("/v1/chat/completions", post(handlers::openai_chat))
        .route("/v1/messages", post(handlers::anthropic_messages))
        .with_state(state)
}

pub async fn start(state: AppState, port: u16) -> tokio::task::JoinHandle<()> {
    let app = router(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind gateway");
    let local = listener.local_addr().unwrap();
    let _ = BOUND.set(local);
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve gateway");
    })
}
```

`proxy/handlers.rs`：
```rust
use crate::auth::{self, AuthError};
use crate::db::models::RequestLog;
use crate::protocol::{anthropic, openai, types::ChatRequest};
use crate::proxy::forwarder::{self, ForwardError};
use crate::proxy::state::AppState;
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

fn extract_key(headers: &HeaderMap) -> Option<String> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(v.to_string());
    }
    if let Some(v) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(s) = v.strip_prefix("Bearer ") {
            return Some(s.to_string());
        }
    }
    None
}

fn err_response(status: StatusCode, code: &str, trace: &str) -> Response {
    (status, Json(json!({"error": {"code": code, "trace_id": trace}}))).into_response()
}

pub async fn health() -> &'static str {
    "ok"
}

pub async fn list_models(State(state): State<AppState>) -> impl IntoResponse {
    let mut models = vec!["sonnet", "opus", "fable", "haiku"]
        .into_iter().map(|s| json!({"id": s, "object": "model"})).collect::<Vec<_>>();
    if let Ok(chs) = state.repo.list_channels() {
        for c in chs.into_iter().filter(|c| c.enabled) {
            for m in c.models {
                models.push(json!({"id": m, "object": "model"}));
            }
        }
    }
    Json(json!({"object": "list", "data": models}))
}

pub async fn openai_chat(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    handle(state, headers, body, Protocol::OpenAI).await
}

pub async fn anthropic_messages(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    handle(state, headers, body, Protocol::Anthropic).await
}

#[derive(Clone, Copy, PartialEq)]
enum Protocol { OpenAI, Anthropic }

async fn handle(state: AppState, headers: HeaderMap, body: serde_json::Value, proto: Protocol) -> Response {
    let trace_id = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();

    // 1. 鉴权
    let key = match extract_key(&headers) {
        Some(k) => k,
        None => return err_response(StatusCode::UNAUTHORIZED, "invalid_api_key", &trace_id),
    };
    let api_key = match auth::authorize(&state.repo, &key) {
        Ok(k) => k,
        Err(AuthError::QuotaExceeded) => return err_response(StatusCode::TOO_MANY_REQUESTS, "quota_exceeded", &trace_id),
        Err(AuthError::Disabled) => return err_response(StatusCode::UNAUTHORIZED, "api_key_disabled", &trace_id),
        Err(AuthError::Invalid) => return err_response(StatusCode::UNAUTHORIZED, "invalid_api_key", &trace_id),
    };

    // 2. 解析为统一格式
    let chat: ChatRequest = match proto {
        Protocol::OpenAI => match openai::request_to_chat(&body) { Ok(c) => c, Err(e) => return err_response(StatusCode::BAD_REQUEST, &e, &trace_id) },
        Protocol::Anthropic => match anthropic::request_to_chat(&body) { Ok(c) => c, Err(e) => return err_response(StatusCode::BAD_REQUEST, &e, &trace_id) },
    };
    let request_model = chat.model.clone();

    // 3. 角色识别
    let role = {
        let conn = state.db.conn();
        let conn = conn.lock().unwrap();
        crate::router::role::detect_role(&conn, &request_model)
    };

    // 4. 角色路由 → (channel_id, target_model)
    let role_route = match &role {
        Some(r) => state.repo.get_role_route(r).ok().flatten()
            .map(|rr| (rr.channel_id, rr.target_model)),
        None => None,
    };

    // 5. 转发
    let result = forwarder::forward(&state, &chat, role_route, &api_key).await;

    // 6. 记录日志 + 扣配额 + 构造响应
    let latency = started.elapsed().as_millis() as i64;
    match result {
        Ok(fr) => {
            let o = &fr.outcome;
            let usage_total = (o.usage.input_tokens + o.usage.output_tokens) as i64;
            let _ = state.repo.consume_quota(&api_key.id, usage_total);
            write_log(&state, &trace_id, &api_key, Some(o), Some(&role), &request_model, proto, None, latency, &body);
            let resp_body = match proto {
                Protocol::OpenAI => openai::chat_to_response(&to_chat_response(o, &request_model)),
                Protocol::Anthropic => anthropic::chat_to_response(&to_chat_response(o, &request_model)),
            };
            (StatusCode::OK, Json(resp_body)).into_response()
        }
        Err(e) => {
            let (status, code) = match &e {
                ForwardError::NoChannel => (StatusCode::SERVICE_UNAVAILABLE, "no_available_channel"),
                ForwardError::Upstream { status, .. } => {
                    (StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY), "upstream_error")
                }
                ForwardError::Http(_) => (StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            };
            write_log(&state, &trace_id, &api_key, None, Some(&role), &request_model, proto, Some(e.to_string()), latency, &body);
            err_response(status, code, &trace_id)
        }
    }
}

fn to_chat_response(o: &forwarder::Outcome, model: &str) -> crate::protocol::types::ChatResponse {
    // 从上游原始 body 提取 content / stop_reason
    let raw = &o.body;
    let content = raw.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .cloned()
        .or_else(|| raw.get("content").cloned())
        .unwrap_or(serde_json::Value::Null);
    let stop = raw.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|s| s.as_str()).map(|s| s.to_string())
        .or_else(|| raw.get("stop_reason").and_then(|s| s.as_str()).map(|s| s.to_string()));
    crate::protocol::types::ChatResponse {
        id: raw.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        model: model.to_string(),
        content,
        stop_reason: stop,
        input_tokens: o.usage.input_tokens,
        output_tokens: o.usage.output_tokens,
        raw: raw.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_log(state: &AppState, trace_id: &str, api_key: &crate::db::models::ApiKey,
             o: Option<&forwarder::Outcome>, role: Option<&Option<String>>, request_model: &str,
             proto: Protocol, error: Option<String>, latency: i64, req_body: &serde_json::Value) {
    let seq = state.repo.next_log_seq().unwrap_or(1);
    let log = RequestLog {
        id: uuid::Uuid::new_v4().to_string(),
        seq,
        trace_id: trace_id.to_string(),
        api_key_id: Some(api_key.id.clone()),
        key_name: Some(api_key.name.clone()),
        channel_id: o.map(|x| x.channel.id.clone()),
        channel_name: o.map(|x| x.channel.name.clone()),
        role: role.cloned().flatten(),
        request_model: Some(request_model.to_string()),
        upstream_model: o.map(|x| x.model.clone()),
        protocol: match proto { Protocol::OpenAI => "openai".into(), Protocol::Anthropic => "anthropic".into() },
        status_code: o.map(|x| x.status as i64),
        input_tokens: o.map(|x| x.usage.input_tokens as i64).unwrap_or(0),
        output_tokens: o.map(|x| x.usage.output_tokens as i64).unwrap_or(0),
        latency_ms: latency,
        is_stream: false,
        error,
        fallback: o.map(|x| x.via_fallback).unwrap_or(false),
        tool_calls: None,
        request_body: Some(req_body.to_string()),
        response_body: o.map(|x| x.body.to_string()),
        created_at: chrono::Utc::now().timestamp(),
    };
    let _ = state.repo.insert_log(&log);
}
```

> 流式说明：本任务 `is_stream` 暂记 false，响应为非流式整包回传。逐 chunk 实时 SSE 透传在 Task 10 作为增强实现（或标注为已知限制，详见 Task 10）。

- [ ] **Step 5: 跑端到端测试确认通过**

Run: `cd src-tauri && cargo test --test gateway_e2e`
Expected: 2 个测试全 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(stage1): axum 网关 server + handlers（双协议端点 + 全管线编排 + 日志入库）"
```

---

## Task 10: 真实 SSE 流式透传（逐 chunk）

**Files:**
- Modify: `src-tauri/src/proxy/forwarder.rs`（加 `forward_stream`）
- Modify: `src-tauri/src/proxy/handlers.rs`（stream 请求走 SSE 响应）
- Test: `tests/stream_e2e.rs`

**Interfaces:**
- Produces:
  - `forwarder::forward_stream(state:&AppState, chat:&ChatRequest, role_route:Option<(String,String)>) -> Result<StreamHandle, ForwardError>`，其中 `StreamHandle { channel: Channel, model: String, via_fallback: bool, byte_stream: impl Stream<Item=Result<Bytes, reqwest::Error>> }`
  - handlers 在 `chat.stream == true` 时返回 `Content-Type: text/event-stream` 的流式 Response，逐 chunk 透传并用 `SseAccumulator` 累积 usage，流结束后写日志 + 扣配额。

**设计定型**：复用 Task 8 的候选序列与失败判定，仅首个候选建立连接成功（收到 2xx 头）后开始透传；若首候选建连即失败（网络/5xx），按序列切换下一候选。流中途失败不重试（避免重复输出）。usage 在流收尾时统一入库。

- [ ] **Step 1: 写流式端到端失败测试**

`tests/stream_e2e.rs`:
```rust
mod common;

use axum::{routing::post, Router};
use futures::stream;
use llm_gateway_lib::db::models::{ApiKey, Channel, RoleRoute};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

async fn spawn_sse_upstream() -> String {
    let app = Router::new().route("/v1/chat/completions", post(|| async {
        let chunks = vec![
            Ok::<_, std::convert::Infallible>(r#"data: {"choices":[{"delta":{"content":"he"}}]}"#.to_string() + "\n\n"),
            Ok(r#"data: {"choices":[{"delta":{"content":"llo"}}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}"#.to_string() + "\n\n"),
            Ok("data: [DONE]".to_string() + "\n\n"),
        ];
        axum::response::Response::builder()
            .header("content-type", "text/event-stream")
            .body(axum::body::Body::from_stream(stream::iter(chunks)))
            .unwrap()
    }));
    let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127,0,0,1],0))).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{}", addr)
}

#[tokio::test]
async fn stream_passthrough_and_usage_logged() {
    let base = spawn_sse_upstream().await;
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&Channel {
        id: "c1".into(), name: "c1".into(), provider_type: "openai".into(),
        base_url: base, api_key: "sk-real".into(), models: vec![], priority: 0,
        weight: 1, enabled: true, timeout_secs: 5, total_calls: 0, total_tokens: 0,
        success_rate: 1.0, avg_latency_ms: 0, created_at: 1, updated_at: 1,
    }).unwrap();
    repo.insert_api_key(&ApiKey {
        id: "k1".into(), key: "sk-lgw-test".into(), name: "t".into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }).unwrap();
    repo.upsert_role_route(&RoleRoute {
        id: "r1".into(), role: "sonnet".into(), channel_id: "c1".into(),
        target_model: "deepseek-v4-flash".into(), enabled: true, updated_at: 1,
    }).unwrap();

    let state = AppState::new(db);
    let _h = server::start(state.clone(), 0).await;
    let addr = server::bound_addr().unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4","stream":true,
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap(), "text/event-stream");
    let text = resp.text().await.unwrap();
    assert!(text.contains("he"));
    assert!(text.contains("[DONE]"));

    // usage 已入库（7 + 2）
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.input_tokens, 7);
    assert_eq!(log.output_tokens, 2);
    assert!(log.is_stream);
    let k = repo.get_api_key_by_key("sk-lgw-test").unwrap().unwrap();
    assert_eq!(k.quota_used, 9);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --test stream_e2e`
Expected: FAIL —— 当前 handler 对 stream 也返回 JSON 整包，`content-type` 非 SSE、`is_stream` false。

- [ ] **Step 3: 实现 `forwarder::forward_stream` + handler SSE 分支**

forwarder 追加：
```rust
use bytes::Bytes;
use futures::Stream;

pub struct StreamHandle {
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
    pub usage_protocol: crate::proxy::sse::Protocol,
    pub byte_stream: std::pin::Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
}

pub async fn forward_stream(
    state: &AppState,
    chat: &ChatRequest,
    role_route: Option<(String, String)>,
) -> Result<StreamHandle, ForwardError> {
    let all = state.repo.list_channels().map_err(|e| ForwardError::Http(e.to_string()))?;
    let by_id = |id: &str| all.iter().find(|c| c.id == id).cloned();
    let mut candidates: Vec<(Channel, String, bool)> = Vec::new();
    if let Some((cid, model)) = &role_route {
        if let Some(ch) = by_id(cid) { candidates.push((ch, model.clone(), false)); }
        if let Some((fid, fmodel)) = state.fallback.read().unwrap().clone() {
            if let Some(fch) = by_id(&fid) { candidates.push((fch, fmodel, true)); }
        }
    } else {
        let maps_fn = |c: &Channel, m: &str| {
            let maps = state.repo.get_model_map(&c.id).unwrap_or_default();
            crate::router::model_map::resolve_model(&maps, m)
        };
        for t in crate::router::dispatch::plan_route(None, None, &all, &maps_fn, &chat.model, 1) {
            candidates.push((t.channel, t.model, t.via_fallback));
        }
    }
    if candidates.is_empty() { return Err(ForwardError::NoChannel); }

    let mut last_err = None;
    for (ch, model, via_fallback) in candidates {
        let url = upstream_url(&ch.provider_type, &ch.base_url, true);
        let mut body = build_upstream_body(chat, &ch.provider_type, &model);
        body["stream"] = serde_json::json!(true);
        let (hname, hval) = auth_header(&ch.provider_type, &ch.api_key);
        let resp = state.http.post(&url)
            .header(hname, hval)
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64))
            .json(&body).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                let usage_protocol = if ch.provider_type == "claude" || ch.provider_type == "anthropic" {
                    crate::proxy::sse::Protocol::Anthropic
                } else {
                    crate::proxy::sse::Protocol::OpenAI
                };
                return Ok(StreamHandle {
                    channel: ch, model, via_fallback, usage_protocol,
                    byte_stream: Box::pin(r.bytes_stream()),
                });
            }
            Ok(r) => {
                let status = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                let e = ForwardError::Upstream { status, body: text };
                if let ForwardError::Upstream { status, .. } = &e {
                    if !is_failover_status(*status) { return Err(e); }
                }
                last_err = Some(e);
            }
            Err(e) => { last_err = Some(ForwardError::Http(e.to_string())); }
        }
    }
    Err(last_err.unwrap_or(ForwardError::NoChannel))
}
```

handlers `handle()` 在 `chat.stream` 为 true 时走流式分支（在解析出 chat、得到 role_route 后、forward 之前分流）：
```rust
    if chat.stream {
        return handle_stream(state, &trace_id, &api_key, chat, role_route, proto, &request_model, &body, started).await;
    }
```

新增 `handle_stream`：
```rust
#[allow(clippy::too_many_arguments)]
async fn handle_stream(state: AppState, trace_id: &str, api_key: &crate::db::models::ApiKey,
                       chat: ChatRequest, role_route: Option<(String,String)>, proto: Protocol,
                       request_model: &str, req_body: &serde_json::Value,
                       started: std::time::Instant) -> Response {
    match forwarder::forward_stream(&state, &chat, role_route).await {
        Ok(handle) => {
            let channel = handle.channel.clone();
            let model = handle.model.clone();
            let via_fallback = handle.via_fallback;
            let usage_protocol = handle.usage_protocol;
            let state2 = state.clone();
            let trace = trace_id.to_string();
            let api_key2 = api_key.clone();
            let role = { let conn = state.db.conn(); let conn = conn.lock().unwrap();
                crate::router::role::detect_role(&conn, request_model) };
            let req_model = request_model.to_string();
            let req_body_s = req_body.to_string();

            let mut acc = crate::proxy::sse::SseAccumulator::new(usage_protocol);
            let stream = handle.byte_stream.map(move |chunk| {
                if let Ok(bytes) = &chunk {
                    let text = String::from_utf8_lossy(bytes);
                    for line in text.split("\n\n") {
                        for l in line.lines() { acc.feed_line(l); }
                    }
                }
                chunk.map(|b| b.into()).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
            });
            // 流结束后写日志（用 on-complete 包装）
            let wrapped = stream.chain(futures::stream::once(async move {
                let usage = acc.usage();
                let _ = state2.repo.consume_quota(&api_key2.id, (usage.input_tokens + usage.output_tokens) as i64);
                let seq = state2.repo.next_log_seq().unwrap_or(1);
                let _ = state2.repo.insert_log(&crate::db::models::RequestLog {
                    id: uuid::Uuid::new_v4().to_string(), seq, trace_id: trace,
                    api_key_id: Some(api_key2.id.clone()), key_name: Some(api_key2.name.clone()),
                    channel_id: Some(channel.id.clone()), channel_name: Some(channel.name.clone()),
                    role, request_model: Some(req_model), upstream_model: Some(model),
                    protocol: match proto { Protocol::OpenAI => "openai".into(), Protocol::Anthropic => "anthropic".into() },
                    status_code: Some(200), input_tokens: usage.input_tokens as i64,
                    output_tokens: usage.output_tokens as i64,
                    latency_ms: started.elapsed().as_millis() as i64, is_stream: true,
                    error: None, fallback: via_fallback, tool_calls: None,
                    request_body: Some(req_body_s), response_body: None,
                    created_at: chrono::Utc::now().timestamp(),
                });
                Ok(bytes::Bytes::new())
            }));

            Response::builder()
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache")
                .body(Body::from_stream(wrapped))
                .unwrap()
        }
        Err(e) => {
            let (status, code) = match &e {
                ForwardError::NoChannel => (StatusCode::SERVICE_UNAVAILABLE, "no_available_channel"),
                ForwardError::Upstream { status, .. } => (StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY), "upstream_error"),
                ForwardError::Http(_) => (StatusCode::BAD_GATEWAY, "upstream_unavailable"),
            };
            err_response(status, code, trace_id)
        }
    }
}
```

> 需要 `use futures::StreamExt;`（`.map`、`.chain`）。acc 闭包捕获的可变性：把 `acc` 包进 `Arc<Mutex<>>` 或重构为先收集再补一条日志帧；实现时按编译器提示调整为 `let acc = std::sync::Arc::new(std::sync::Mutex::new(acc))`，在两个闭包间共享。

- [ ] **Step 4: 跑流式测试确认通过**

Run: `cd src-tauri && cargo test --test stream_e2e`
Expected: PASS（SSE content-type、内容透传、usage 入库、is_stream=true、配额=9）。

- [ ] **Step 5: 回归全部后端测试**

Run: `cd src-tauri && cargo test`
Expected: lib 单测 + 3 个集成测试文件全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(stage1): 真实 SSE 流式透传（逐chunk + 流尾usage入库+配额）"
```

---

## Task 11: Tauri 入口（lib.rs run）+ 网关随应用启动 + 托盘 + tauri.conf

**Files:**
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/icons/`（占位图标，可先用 `pnpm tauri icon` 生成或拷贝简单 png）
- Modify: `src-tauri/src/lib.rs`（实现 `run()`）
- Modify: `src-tauri/Cargo.toml`（确认 tauri features）
- Test: 手动 `pnpm tauri dev` 起应用 + `curl /health`

**Interfaces:**
- Produces:
  - `run()` —— Tauri builder：初始化 Db（应用数据目录 `llm-gateway.db`）→ `AppState` → 启动网关 8777 → 注册 commands → 托盘退出
  - 网关端口固定 8777（占用则在日志告警并尝试 8778…8787）

- [ ] **Step 1: 写 `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "llm-gateway",
  "version": "0.1.0",
  "identifier": "com.llmgateway.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm run dev:renderer",
    "beforeBuildCommand": "pnpm run build:renderer"
  },
  "app": {
    "windows": [
      { "label": "main", "title": "llm-gateway", "width": 1100, "height": 720, "minWidth": 900, "minHeight": 600, "center": true }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

- [ ] **Step 2: 实现 `lib.rs run()`**

```rust
pub mod auth;
pub mod db;
pub mod error;
pub mod provider;
pub mod protocol;
pub mod proxy;
pub mod router;

use db::Db;
use proxy::state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app_data_dir");
            std::fs::create_dir_all(&dir).ok();
            let db = Db::open(&dir.join("llm-gateway.db")).expect("open db");
            let state = AppState::new(db);
            app.manage(state.clone());

            // 启动网关（独立 tokio runtime 线程，避免阻塞 Tauri）
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async move {
                    for port in 8777..=8787 {
                        let listener = tokio::net::TcpListener::bind(
                            std::net::SocketAddr::from(([127, 0, 0, 1], port))).await;
                        if let Ok(l) = listener {
                            log::info!("llm-gateway listening on 127.0.0.1:{}", port);
                            let app_router = proxy::server::router(state.clone());
                            axum::serve(l, app_router).await.expect("serve");
                            return;
                        }
                    }
                    log::error!("no available port in 8777..=8787");
                });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

> `proxy::server::router(state)` 已在 Task 9 提供（与 `start` 分离就是为了这里复用）。commands 在 Task 12 注册进 `generate_handler!`。

- [ ] **Step 3: 准备图标 + 前端最小占位以便 dev 启动**

```bash
cd /Users/zhouqiao/workplace/project/llm-gateway
mkdir -p src-tauri/icons
# 用 cc-switch 的图标先占位（后续替换品牌图）
cp /Users/zhouqiao/workplace/project/cc-switch/src-tauri/icons/32x32.png src-tauri/icons/ 2>/dev/null || true
cp /Users/zhouqiao/workplace/project/cc-switch/src-tauri/icons/128x128.png src-tauri/icons/ 2>/dev/null || true
cp /Users/zhouqiao/workplace/project/cc-switch/src-tauri/icons/128x128@2x.png src-tauri/icons/ 2>/dev/null || true
cp /Users/zhouqiao/workplace/project/cc-switch/src-tauri/icons/icon.icns src-tauri/icons/ 2>/dev/null || true
cp /Users/zhouqiao/workplace/project/cc-switch/src-tauri/icons/icon.ico src-tauri/icons/ 2>/dev/null || true
```

- [ ] **Step 4: 验证编译（前端在 Task 12/13 才完整，此步先确保后端可编译）**

Run: `cd src-tauri && cargo build`
Expected: 编译通过（可能有 commands 未注册的空 handler 警告，可忽略）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): Tauri 入口 + 网关随应用启动(8777) + tauri.conf + 图标占位"
```

---

## Task 12: Tauri Commands（前端 ↔ 后端）+ 前端 API 封装

**Files:**
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/channel.rs`
- Create: `src-tauri/src/commands/api_key.rs`
- Create: `src-tauri/src/commands/role_route.rs`
- Create: `src-tauri/src/commands/log.rs`
- Create: `src-tauri/src/commands/stats.rs`
- Modify: `src-tauri/src/lib.rs`（注册 `pub mod commands;` + `generate_handler!`）
- Modify: `src-tauri/src/db/repository.rs`（补 update/delete/list 方法 + 日志分页查询 + 统计）
- Create: `src/types/index.ts`、`src/lib/api.ts`

**Interfaces:**
- Produces（Tauri commands，camelCase 出参）：
  - `list_channels() -> Vec<Channel>`、`create_channel(input: ChannelInput) -> Channel`、`update_channel(c: Channel) -> ()`、`delete_channel(id: String) -> ()`、`test_channel(id: String) -> TestResult { ok: bool, latency_ms: i64, error: Option<String> }`
  - `list_api_keys() -> Vec<ApiKey>`、`create_api_key(name: String, quota_total: Option<i64>) -> ApiKey`（服务端生成 key）、`set_api_key_enabled(id: String, enabled: bool) -> ()`、`delete_api_key(id: String) -> ()`、`update_quota(id: String, quota_total: Option<i64>) -> ()`
  - `list_role_routes() -> Vec<RoleRoute>`、`set_role_route(role: String, channel_id: String, target_model: String) -> ()`、`delete_role_route(role: String) -> ()`、`list_role_patterns() -> Vec<RolePattern>`、`upsert_role_pattern(p: RolePattern) -> ()`、`delete_role_pattern(id: String) -> ()`、`get_fallback() -> Option<(String,String)>`、`set_fallback(channel_id: String, model: String) -> ()`、`clear_fallback() -> ()`
  - `list_logs(filter: LogFilter) -> LogPage { items: Vec<RequestLog>, total: i64 }`、`get_log(id: String) -> Option<RequestLog>`
  - `get_stats() -> Stats { today_requests, today_tokens, total_requests, total_tokens, active_channels, avg_latency_ms }`
  - 前端 `api.ts` 对每个 command 一个 invoke 封装函数。

**设计定型**：渠道 `api_key` 在 `list_channels` 出参里**打码**为 `sk-***<后4位>`，避免明文下发前端；`create/update` 才接收明文。fallback 存 `tauri-plugin-store`（key=`fallback`），并同步写入 `AppState.fallback`。

- [ ] **Step 1: 在 repository.rs 补 CRUD/查询/统计方法**

```rust
    pub fn update_channel(&self, c: &Channel) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute(
            "UPDATE channels SET name=?2,provider_type=?3,base_url=?4,api_key=?5,models=?6,priority=?7,weight=?8,enabled=?9,timeout_secs=?10,updated_at=?11 WHERE id=?1",
            rusqlite::params![c.id,c.name,c.provider_type,c.base_url,c.api_key,serde_json::to_string(&c.models).unwrap(),c.priority,c.weight,c.enabled as i64,c.timeout_secs,c.updated_at],
        )?; Ok(())
    }
    pub fn delete_channel(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM channels WHERE id=?1", [id])?; Ok(())
    }
    pub fn set_api_key_enabled(&self, id: &str, enabled: bool) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("UPDATE api_keys SET enabled=?2 WHERE id=?1", rusqlite::params![id, enabled as i64])?; Ok(())
    }
    pub fn delete_api_key(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM api_keys WHERE id=?1", [id])?; Ok(())
    }
    pub fn update_quota(&self, id: &str, quota_total: Option<i64>) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("UPDATE api_keys SET quota_total=?2 WHERE id=?1", rusqlite::params![id, quota_total])?; Ok(())
    }
    pub fn list_api_keys(&self) -> AppResult<Vec<ApiKey>> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at FROM api_keys ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| Ok(ApiKey {
            id: r.get(0)?, key: r.get(1)?, name: r.get(2)?, enabled: r.get::<_,i64>(3)? != 0,
            quota_total: r.get(4)?, quota_used: r.get(5)?, total_calls: r.get(6)?,
            total_tokens: r.get(7)?, created_at: r.get(8)?, last_used_at: r.get(9)?,
        }))?;
        let mut out = Vec::new(); for r in rows { out.push(r?); } Ok(out)
    }
    pub fn delete_role_route(&self, role: &str) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM role_routes WHERE role=?1", [role])?; Ok(())
    }
    pub fn list_role_routes(&self) -> AppResult<Vec<crate::db::models::RoleRoute>> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,role,channel_id,target_model,enabled,updated_at FROM role_routes")?;
        let rows = stmt.query_map([], |r| Ok(crate::db::models::RoleRoute {
            id: r.get(0)?, role: r.get(1)?, channel_id: r.get(2)?, target_model: r.get(3)?,
            enabled: r.get::<_,i64>(4)? != 0, updated_at: r.get(5)?,
        }))?;
        let mut out = Vec::new(); for r in rows { out.push(r?); } Ok(out)
    }
    pub fn upsert_role_pattern(&self, p: &crate::db::models::RolePattern) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO role_patterns (id,pattern,role,priority,enabled) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET pattern=excluded.pattern, role=excluded.role, priority=excluded.priority, enabled=excluded.enabled",
            rusqlite::params![p.id,p.pattern,p.role,p.priority,p.enabled as i64],
        )?; Ok(())
    }
    pub fn delete_role_pattern(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        conn.execute("DELETE FROM role_patterns WHERE id=?1", [id])?; Ok(())
    }
    pub fn count_logs(&self, keyword: Option<&str>) -> AppResult<i64> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        let n: i64 = match keyword {
            Some(k) => conn.query_row(
                "SELECT COUNT(*) FROM request_logs WHERE request_model LIKE ?1 OR upstream_model LIKE ?1 OR trace_id LIKE ?1 OR channel_name LIKE ?1 OR key_name LIKE ?1",
                [format!("%{}%", k)], |r| r.get(0))?,
            None => conn.query_row("SELECT COUNT(*) FROM request_logs", [], |r| r.get(0))?,
        };
        Ok(n)
    }
    pub fn list_logs(&self, keyword: Option<&str>, limit: i64, offset: i64) -> AppResult<Vec<RequestLog>> {
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        let like = keyword.map(|k| format!("%{}%", k));
        let sql = "SELECT id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,created_at FROM request_logs
                   WHERE (?1 IS NULL OR request_model LIKE ?1 OR upstream_model LIKE ?1 OR trace_id LIKE ?1 OR channel_name LIKE ?1 OR key_name LIKE ?1)
                   ORDER BY seq DESC LIMIT ?2 OFFSET ?3";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![like, limit, offset], |r| Ok(RequestLog {
            id: r.get(0)?, seq: r.get(1)?, trace_id: r.get(2)?, api_key_id: r.get(3)?,
            key_name: r.get(4)?, channel_id: r.get(5)?, channel_name: r.get(6)?, role: r.get(7)?,
            request_model: r.get(8)?, upstream_model: r.get(9)?, protocol: r.get(10)?,
            status_code: r.get(11)?, input_tokens: r.get(12)?, output_tokens: r.get(13)?,
            latency_ms: r.get(14)?, is_stream: r.get::<_,i64>(15)? != 0, error: r.get(16)?,
            fallback: r.get::<_,i64>(17)? != 0, tool_calls: r.get(18)?, request_body: r.get(19)?,
            response_body: r.get(20)?, created_at: r.get(21)?,
        }))?;
        let mut out = Vec::new(); for r in rows { out.push(r?); } Ok(out)
    }
    pub fn stats(&self) -> AppResult<(i64,i64,i64,i64,i64,i64)> {
        // (today_requests, today_tokens, total_requests, total_tokens, active_channels, avg_latency_ms)
        let conn = self.db.conn(); let conn = conn.lock().unwrap();
        let today_start = chrono::Local::now().date_naive().and_hms_opt(0,0,0).unwrap().timestamp();
        let (tr, tt): (i64,i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens+output_tokens),0) FROM request_logs WHERE created_at>=?1",
            [today_start], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let (ar, at): (i64,i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens+output_tokens),0) FROM request_logs", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let ac: i64 = conn.query_row("SELECT COUNT(*) FROM channels WHERE enabled=1", [], |r| r.get(0))?;
        let lat: i64 = conn.query_row("SELECT COALESCE(AVG(latency_ms),0) FROM request_logs", [], |r| r.get(0))?;
        Ok((tr, tt, ar, at, ac, lat))
    }
```

- [ ] **Step 2: 写 commands 模块（每个文件一组 command）**

`commands/mod.rs`:
```rust
pub mod api_key;
pub mod channel;
pub mod log;
pub mod role_route;
pub mod stats;
```

`commands/channel.rs`:
```rust
use crate::db::models::Channel;
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

fn mask(key: &str) -> String {
    if key.len() <= 4 { return "****".into(); }
    format!("sk-***{}", &key[key.len()-4..])
}

#[derive(Serialize)]
pub struct TestResult { pub ok: bool, pub latency_ms: i64, pub error: Option<String> }

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Result<Vec<Channel>, String> {
    let mut cs = state.repo.list_channels().map_err(|e| e.to_string())?;
    for c in &mut cs { c.api_key = mask(&c.api_key); }
    Ok(cs)
}

#[tauri::command]
pub fn create_channel(state: State<AppState>, mut c: Channel) -> Result<Channel, String> {
    c.id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    c.created_at = now; c.updated_at = now;
    state.repo.insert_channel(&c).map_err(|e| e.to_string())?;
    let mut out = c.clone(); out.api_key = mask(&out.api_key);
    Ok(out)
}

#[tauri::command]
pub fn update_channel(state: State<AppState>, mut c: Channel) -> Result<(), String> {
    c.updated_at = chrono::Utc::now().timestamp();
    // api_key 若是打码形式则不更新（保留原值）
    if c.api_key.starts_with("sk-***") {
        if let Some(orig) = state.repo.get_channel(&c.id).map_err(|e| e.to_string())? {
            c.api_key = orig.api_key;
        }
    }
    state.repo.update_channel(&c).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_channel(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_channel(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_channel(state: State<'_, AppState>, id: String) -> Result<TestResult, String> {
    let ch = state.repo.get_channel(&id).map_err(|e| e.to_string())?
        .ok_or_else(|| "channel not found".to_string())?;
    let url = crate::provider::adapter::upstream_url(&ch.provider_type, &ch.base_url, false);
    let (hname, hval) = crate::provider::adapter::auth_header(&ch.provider_type, &ch.api_key);
    let start = std::time::Instant::now();
    let body = serde_json::json!({"model": ch.models.get(0).cloned().unwrap_or("test".into()),
        "messages":[{"role":"user","content":"ping"}], "max_tokens": 1});
    let resp = state.http.post(&url).header(hname, hval)
        .header("content-type","application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64))
        .json(&body).send().await;
    let latency = start.elapsed().as_millis() as i64;
    match resp {
        Ok(r) if r.status().is_success() => Ok(TestResult{ ok: true, latency_ms: latency, error: None }),
        Ok(r) => Ok(TestResult{ ok: false, latency_ms: latency, error: Some(format!("status {}", r.status())) }),
        Err(e) => Ok(TestResult{ ok: false, latency_ms: latency, error: Some(e.to_string()) }),
    }
}
```

`commands/api_key.rs`:
```rust
use crate::db::models::ApiKey;
use crate::proxy::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_api_keys(state: State<AppState>) -> Result<Vec<ApiKey>, String> {
    state.repo.list_api_keys().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_api_key(state: State<AppState>, name: String, quota_total: Option<i64>) -> Result<ApiKey, String> {
    let k = ApiKey {
        id: uuid::Uuid::new_v4().to_string(),
        key: crate::auth::generate_key(),
        name, enabled: true, quota_total, quota_used: 0,
        total_calls: 0, total_tokens: 0,
        created_at: chrono::Utc::now().timestamp(), last_used_at: None,
    };
    state.repo.insert_api_key(&k).map_err(|e| e.to_string())?;
    Ok(k)
}

#[tauri::command]
pub fn set_api_key_enabled(state: State<AppState>, id: String, enabled: bool) -> Result<(), String> {
    state.repo.set_api_key_enabled(&id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_api_key(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_quota(state: State<AppState>, id: String, quota_total: Option<i64>) -> Result<(), String> {
    state.repo.update_quota(&id, quota_total).map_err(|e| e.to_string())
}
```

`commands/role_route.rs`:
```rust
use crate::db::models::{RolePattern, RoleRoute};
use crate::proxy::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_role_routes(state: State<AppState>) -> Result<Vec<RoleRoute>, String> {
    state.repo.list_role_routes().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_role_route(state: State<AppState>, role: String, channel_id: String, target_model: String) -> Result<(), String> {
    let rr = RoleRoute {
        id: uuid::Uuid::new_v4().to_string(), role, channel_id, target_model,
        enabled: true, updated_at: chrono::Utc::now().timestamp(),
    };
    state.repo.upsert_role_route(&rr).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_route(state: State<AppState>, role: String) -> Result<(), String> {
    state.repo.delete_role_route(&role).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_role_patterns(state: State<AppState>) -> Result<Vec<RolePattern>, String> {
    state.repo.list_role_patterns().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_role_pattern(state: State<AppState>, mut p: RolePattern) -> Result<(), String> {
    if p.id.is_empty() { p.id = uuid::Uuid::new_v4().to_string(); }
    state.repo.upsert_role_pattern(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_role_pattern(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_role_pattern(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_fallback(state: State<AppState>) -> Option<(String, String)> {
    state.fallback.read().unwrap().clone()
}

#[tauri::command]
pub fn set_fallback(state: State<AppState>, channel_id: String, model: String) {
    *state.fallback.write().unwrap() = Some((channel_id, model));
}

#[tauri::command]
pub fn clear_fallback(state: State<AppState>) {
    *state.fallback.write().unwrap() = None;
}
```

`commands/log.rs`:
```rust
use crate::db::models::RequestLog;
use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize)]
pub struct LogFilter { pub keyword: Option<String>, pub limit: Option<i64>, pub offset: Option<i64> }

#[derive(Serialize)]
pub struct LogPage { pub items: Vec<RequestLog>, pub total: i64 }

#[tauri::command]
pub fn list_logs(state: State<AppState>, filter: LogFilter) -> Result<LogPage, String> {
    let kw = filter.keyword.as_deref();
    let items = state.repo.list_logs(kw, filter.limit.unwrap_or(50), filter.offset.unwrap_or(0)).map_err(|e| e.to_string())?;
    let total = state.repo.count_logs(kw).map_err(|e| e.to_string())?;
    Ok(LogPage { items, total })
}
```

`commands/stats.rs`:
```rust
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Stats {
    pub today_requests: i64, pub today_tokens: i64,
    pub total_requests: i64, pub total_tokens: i64,
    pub active_channels: i64, pub avg_latency_ms: i64,
}

#[tauri::command]
pub fn get_stats(state: State<AppState>) -> Result<Stats, String> {
    let (tr, tt, ar, at, ac, lat) = state.repo.stats().map_err(|e| e.to_string())?;
    Ok(Stats { today_requests: tr, today_tokens: tt, total_requests: ar, total_tokens: at, active_channels: ac, avg_latency_ms: lat })
}
```

- [ ] **Step 3: 注册 commands + handler，跑后端编译**

`src-tauri/src/lib.rs`：
- 顶部加 `pub mod commands;`
- `invoke_handler(tauri::generate_handler![ ... ])` 填入全部 command：
```rust
        .invoke_handler(tauri::generate_handler![
            commands::channel::list_channels, commands::channel::create_channel,
            commands::channel::update_channel, commands::channel::delete_channel,
            commands::channel::test_channel,
            commands::api_key::list_api_keys, commands::api_key::create_api_key,
            commands::api_key::set_api_key_enabled, commands::api_key::delete_api_key,
            commands::api_key::update_quota,
            commands::role_route::list_role_routes, commands::role_route::set_role_route,
            commands::role_route::delete_role_route, commands::role_route::list_role_patterns,
            commands::role_route::upsert_role_pattern, commands::role_route::delete_role_pattern,
            commands::role_route::get_fallback, commands::role_route::set_fallback,
            commands::role_route::clear_fallback,
            commands::log::list_logs,
            commands::stats::get_stats,
        ])
```
Run: `cd src-tauri && cargo build`
Expected: 编译通过。

- [ ] **Step 4: 写前端类型 + API 封装**

`src/types/index.ts`:
```ts
export interface Channel {
  id: string; name: string; provider_type: string; base_url: string; api_key: string;
  models: string[]; priority: number; weight: number; enabled: boolean; timeout_secs: number;
  total_calls: number; total_tokens: number; success_rate: number; avg_latency_ms: number;
  created_at: number; updated_at: number;
}
export interface ApiKey {
  id: string; key: string; name: string; enabled: boolean;
  quota_total: number | null; quota_used: number; total_calls: number; total_tokens: number;
  created_at: number; last_used_at: number | null;
}
export interface RoleRoute {
  id: string; role: string; channel_id: string; target_model: string; enabled: boolean; updated_at: number;
}
export interface RolePattern {
  id: string; pattern: string; role: string; priority: number; enabled: boolean;
}
export interface RequestLog {
  id: string; seq: number; trace_id: string; api_key_id: string | null; key_name: string | null;
  channel_id: string | null; channel_name: string | null; role: string | null;
  request_model: string | null; upstream_model: string | null; protocol: string;
  status_code: number | null; input_tokens: number; output_tokens: number; latency_ms: number;
  is_stream: boolean; error: string | null; fallback: boolean; tool_calls: string | null;
  request_body: string | null; response_body: string | null; created_at: number;
}
export interface Stats {
  today_requests: number; today_tokens: number; total_requests: number; total_tokens: number;
  active_channels: number; avg_latency_ms: number;
}
export interface LogPage { items: RequestLog[]; total: number; }
export interface TestResult { ok: boolean; latency_ms: number; error: string | null; }
```

`src/lib/api.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import type { ApiKey, Channel, LogPage, RequestLog, RolePattern, RoleRoute, Stats, TestResult } from "../types";

export const api = {
  listChannels: () => invoke<Channel[]>("list_channels"),
  createChannel: (c: Channel) => invoke<Channel>("create_channel", { c }),
  updateChannel: (c: Channel) => invoke<void>("update_channel", { c }),
  deleteChannel: (id: string) => invoke<void>("delete_channel", { id }),
  testChannel: (id: string) => invoke<TestResult>("test_channel", { id }),

  listApiKeys: () => invoke<ApiKey[]>("list_api_keys"),
  createApiKey: (name: string, quota_total: number | null) =>
    invoke<ApiKey>("create_api_key", { name, quotaTotal: quota_total }),
  setApiKeyEnabled: (id: string, enabled: boolean) => invoke<void>("set_api_key_enabled", { id, enabled }),
  deleteApiKey: (id: string) => invoke<void>("delete_api_key", { id }),
  updateQuota: (id: string, quota_total: number | null) => invoke<void>("update_quota", { id, quotaTotal: quota_total }),

  listRoleRoutes: () => invoke<RoleRoute[]>("list_role_routes"),
  setRoleRoute: (role: string, channel_id: string, target_model: string) =>
    invoke<void>("set_role_route", { role, channelId: channel_id, targetModel: target_model }),
  deleteRoleRoute: (role: string) => invoke<void>("delete_role_route", { role }),
  listRolePatterns: () => invoke<RolePattern[]>("list_role_patterns"),
  upsertRolePattern: (p: RolePattern) => invoke<void>("upsert_role_pattern", { p }),
  deleteRolePattern: (id: string) => invoke<void>("delete_role_pattern", { id }),
  getFallback: () => invoke<[string, string] | null>("get_fallback"),
  setFallback: (channel_id: string, model: string) => invoke<void>("set_fallback", { channelId: channel_id, model }),
  clearFallback: () => invoke<void>("clear_fallback"),

  listLogs: (keyword: string | null, limit: number, offset: number) =>
    invoke<LogPage>("list_logs", { filter: { keyword, limit, offset } }),
  getStats: () => invoke<Stats>("get_stats"),
};
export type { RequestLog };
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): Tauri Commands（渠道/密钥/角色路由/日志/统计）+ 前端类型与API封装"
```

---

## Task 13: 前端脚手架 + Layout + 路由

**Files:**
- Create: `package.json`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.cjs`、`postcss.config.cjs`、`index.html`
- Create: `src/main.tsx`、`src/App.tsx`、`src/index.css`
- Create: `src/components/Layout.tsx`
- Create: `src/pages/DashboardPage.tsx`（占位，Task 14 填充）

**Interfaces:**
- Produces: Vite + React + TS + Tailwind + React Router 工程，`<Layout>` 含侧边栏导航（概览/渠道/密钥/角色路由/日志），路由到 5 个页面。

- [ ] **Step 1: 写工程配置文件**

`package.json`:
```json
{
  "name": "llm-gateway",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "pnpm tauri dev",
    "build": "pnpm tauri build",
    "tauri": "tauri",
    "dev:renderer": "vite",
    "build:renderer": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.8.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^7.1.0",
    "zustand": "^5.0.0",
    "lucide-react": "^0.460.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.8.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.6.3",
    "vite": "^7.0.0",
    "vitest": "^2.1.8",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "jsdom": "^25.0.1"
  }
}
```

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2021", outDir: "dist" },
  test: { environment: "jsdom", globals: true },
} as any);
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021", "useDefineForClassFields": true, "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext", "skipLibCheck": true, "moduleResolution": "bundler",
    "allowImportingTsExtensions": true, "resolveJsonModule": true, "isolatedModules": true,
    "noEmit": true, "jsx": "react-jsx", "strict": true, "noUnusedLocals": false, "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

`tailwind.config.cjs`:
```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
```

`postcss.config.cjs`:
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>llm-gateway</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 2: 写入口与样式、Layout、App 路由**

`src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body { @apply bg-gray-50 text-gray-900; }
```

`src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
```

`src/components/Layout.tsx`:
```tsx
import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Server, KeyRound, Route, ScrollText } from "lucide-react";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/channels", label: "渠道", icon: Server },
  { to: "/keys", label: "密钥", icon: KeyRound },
  { to: "/roles", label: "角色路由", icon: Route },
  { to: "/logs", label: "日志", icon: ScrollText },
];

export default function Layout() {
  return (
    <div className="flex h-screen">
      <aside className="w-52 border-r bg-white p-3">
        <div className="mb-6 px-2 text-lg font-bold">llm-gateway</div>
        <nav className="space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded px-3 py-2 text-sm ${isActive ? "bg-blue-600 text-white" : "hover:bg-gray-100"}`}>
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

`src/App.tsx`:
```tsx
import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import ChannelsPage from "./pages/ChannelsPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import RoleRoutesPage from "./pages/RoleRoutesPage";
import LogsPage from "./pages/LogsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/keys" element={<ApiKeysPage />} />
        <Route path="/roles" element={<RoleRoutesPage />} />
        <Route path="/logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 3: 安装依赖 + 类型检查**

```bash
cd /Users/zhouqiao/workplace/project/llm-gateway
pnpm install
pnpm typecheck
```
Expected: 安装成功，typecheck 通过（页面文件在 Task 14 创建，此步可能报模块缺失 —— 先创建占位页面）。

- [ ] **Step 4: 创建 5 个占位页面（避免 typecheck 报错）**

`src/pages/DashboardPage.tsx`（其余 4 个同结构，改名字）：
```tsx
export default function DashboardPage() {
  return <div className="text-gray-500">概览（待实现）</div>;
}
```
`ChannelsPage.tsx` / `ApiKeysPage.tsx` / `RoleRoutesPage.tsx` / `LogsPage.tsx` 同构占位。

再跑 `pnpm typecheck`，Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(stage1): 前端脚手架 + Layout侧边栏 + 路由 + 5占位页面"
```

---

## Task 14: 前端五个功能页面

**Files:**
- Modify: `src/pages/DashboardPage.tsx`
- Modify: `src/pages/ChannelsPage.tsx`
- Modify: `src/pages/ApiKeysPage.tsx`
- Modify: `src/pages/RoleRoutesPage.tsx`
- Modify: `src/pages/LogsPage.tsx`
- Create: `src/components/ChannelForm.tsx`
- Test: `src/pages/__tests__/RoleRoutesPage.test.tsx`（vitest，mock api）

**Interfaces:**
- Consumes: `lib/api.ts`（Task 12）、`types/index.ts`
- Produces: 5 个可用页面；`ChannelForm` 复用于新建/编辑渠道。

- [ ] **Step 1: DashboardPage（统计卡片）**

```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Stats } from "../types";

export default function DashboardPage() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => { api.getStats().then(setS).catch(console.error); }, []);
  if (!s) return <div>加载中…</div>;
  const cards = [
    { label: "今日请求", value: s.today_requests },
    { label: "今日 Token", value: s.today_tokens },
    { label: "累计请求", value: s.total_requests },
    { label: "累计 Token", value: s.total_tokens },
    { label: "活跃渠道", value: s.active_channels },
    { label: "平均延迟(ms)", value: s.avg_latency_ms },
  ];
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">概览</h1>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border bg-white p-4">
            <div className="text-sm text-gray-500">{c.label}</div>
            <div className="mt-1 text-2xl font-bold">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: ChannelForm + ChannelsPage**

`src/components/ChannelForm.tsx`:
```tsx
import { useState } from "react";
import type { Channel } from "../types";

const PROVIDERS = ["openai", "claude", "deepseek", "gemini", "custom"];

export default function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (c: Channel) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<Channel>>({
    provider_type: "openai", priority: 0, weight: 1, enabled: true,
    timeout_secs: 60, models: [], ...initial,
  });
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div className="space-y-3 rounded-lg border bg-white p-4">
      <input className="w-full border rounded px-2 py-1" placeholder="名称" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} />
      <select className="w-full border rounded px-2 py-1" value={f.provider_type} onChange={(e) => set("provider_type", e.target.value)}>
        {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <input className="w-full border rounded px-2 py-1" placeholder="Base URL，如 https://api.deepseek.com" value={f.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} />
      <input className="w-full border rounded px-2 py-1" placeholder="真实上游 API Key" value={f.api_key ?? ""} onChange={(e) => set("api_key", e.target.value)} />
      <input className="w-full border rounded px-2 py-1" placeholder="支持模型（逗号分隔）" value={(f.models ?? []).join(",")} onChange={(e) => set("models", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
      <div className="flex gap-2">
        <input type="number" className="w-1/2 border rounded px-2 py-1" placeholder="优先级" value={f.priority ?? 0} onChange={(e) => set("priority", Number(e.target.value))} />
        <input type="number" className="w-1/2 border rounded px-2 py-1" placeholder="权重" value={f.weight ?? 1} onChange={(e) => set("weight", Number(e.target.value))} />
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded border px-3 py-1" onClick={onCancel}>取消</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-white"
          onClick={() => onSubmit(f as Channel)}>保存</button>
      </div>
    </div>
  );
}
```

`src/pages/ChannelsPage.tsx`:
```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Channel } from "../types";
import ChannelForm from "../components/ChannelForm";

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [creating, setCreating] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const load = () => api.listChannels().then(setList).catch(console.error);
  useEffect(() => { load(); }, []);

  const save = async (c: Channel) => {
    if (c.id) await api.updateChannel(c); else await api.createChannel(c);
    setCreating(false); setEditing(null); load();
  };
  const test = async (id: string) => {
    const r = await api.testChannel(id);
    setTestMsg((m) => ({ ...m, [id]: r.ok ? `✓ ${r.latency_ms}ms` : `✗ ${r.error}` }));
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">渠道管理</h1>
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => setCreating(true)}>新建渠道</button>
      </div>
      {(creating || editing) && (
        <div className="mb-4">
          <ChannelForm initial={editing ?? undefined} onSubmit={save} onCancel={() => { setCreating(false); setEditing(null); }} />
        </div>
      )}
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">名称</th><th>类型</th><th>Base URL</th><th>优先级/权重</th><th>模型</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id} className="border-b">
              <td className="p-2">{c.name}</td>
              <td>{c.provider_type}</td>
              <td className="max-w-[180px] truncate">{c.base_url}</td>
              <td>{c.priority}/{c.weight}</td>
              <td className="max-w-[160px] truncate">{c.models.join(",")}</td>
              <td>{c.enabled ? "启用" : "禁用"}</td>
              <td className="space-x-2">
                <button className="text-blue-600" onClick={() => setEditing(c)}>编辑</button>
                <button className="text-green-600" onClick={() => test(c.id)}>测试</button>
                <button className="text-red-600" onClick={() => api.deleteChannel(c.id).then(load)}>删除</button>
                {testMsg[c.id] && <span className="text-xs">{testMsg[c.id]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: ApiKeysPage（生成/复制/配额/启停）**

```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ApiKey } from "../types";

export default function ApiKeysPage() {
  const [list, setList] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const load = () => api.listApiKeys().then(setList).catch(console.error);
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name) return;
    await api.createApiKey(name, quota ? Number(quota) : null);
    setName(""); setQuota(""); load();
  };

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">API 密钥</h1>
      <div className="mb-4 flex gap-2">
        <input className="border rounded px-2 py-1" placeholder="用户/应用名" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="border rounded px-2 py-1" placeholder="Token 配额（留空不限）" value={quota} onChange={(e) => setQuota(e.target.value)} />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={create}>生成密钥</button>
      </div>
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">名称</th><th>密钥</th><th>配额(已用/总量)</th><th>调用</th><th>Token</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} className="border-b">
              <td className="p-2">{k.name}</td>
              <td className="font-mono text-xs">{k.key}
                <button className="ml-1 text-blue-600" onClick={() => navigator.clipboard.writeText(k.key)}>复制</button></td>
              <td>{k.quota_used}/{k.quota_total ?? "∞"}</td>
              <td>{k.total_calls}</td><td>{k.total_tokens}</td>
              <td>{k.enabled ? "启用" : "禁用"}</td>
              <td className="space-x-2">
                <button className="text-blue-600" onClick={() => api.setApiKeyEnabled(k.id, !k.enabled).then(load)}>{k.enabled ? "禁用" : "启用"}</button>
                <button className="text-red-600" onClick={() => api.deleteApiKey(k.id).then(load)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: RoleRoutesPage（角色绑定 + 识别规则 + 全局兜底）★**

```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Channel, RolePattern, RoleRoute } from "../types";

const ROLES = ["sonnet", "opus", "fable", "haiku"];

export default function RoleRoutesPage() {
  const [routes, setRoutes] = useState<RoleRoute[]>([]);
  const [patterns, setPatterns] = useState<RolePattern[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [fallback, setFallbackState] = useState<[string, string] | null>(null);

  const load = () => {
    api.listRoleRoutes().then(setRoutes).catch(console.error);
    api.listRolePatterns().then(setPatterns).catch(console.error);
    api.listChannels().then(setChannels).catch(console.error);
    api.getFallback().then(setFallbackState).catch(console.error);
  };
  useEffect(() => { load(); }, []);

  const routeFor = (role: string) => routes.find((r) => r.role === role);

  const bind = async (role: string, channel_id: string, target_model: string) => {
    if (!channel_id) { await api.deleteRoleRoute(role); } else { await api.setRoleRoute(role, channel_id, target_model); }
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-xl font-bold">角色路由</h1>
        <p className="mb-3 text-sm text-gray-500">Claude Code 请求里的角色 → 固定走指定渠道的上游模型；失败走全局兜底。</p>
        <table className="w-full border bg-white text-sm">
          <thead><tr className="border-b text-left"><th className="p-2">角色</th><th>渠道</th><th>上游模型</th></tr></thead>
          <tbody>
            {ROLES.map((role) => {
              const r = routeFor(role);
              return (
                <tr key={role} className="border-b">
                  <td className="p-2 font-medium">{role}</td>
                  <td>
                    <select className="border rounded px-2 py-1" value={r?.channel_id ?? ""}
                      onChange={(e) => bind(role, e.target.value, r?.target_model ?? "")}>
                      <option value="">（不路由 / 走普通调度）</option>
                      {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="w-full border rounded px-2 py-1" placeholder="上游模型，如 deepseek-v4-flash"
                      defaultValue={r?.target_model ?? ""} disabled={!r?.channel_id}
                      onBlur={(e) => r?.channel_id && bind(role, r.channel_id, e.target.value)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">全局兜底模型</h2>
        <div className="flex gap-2">
          <select className="border rounded px-2 py-1" value={fallback?.[0] ?? ""}
            onChange={(e) => e.target.value ? api.setFallback(e.target.value, fallback?.[1] ?? "").then(load) : api.clearFallback().then(load)}>
            <option value="">（无兜底）</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="border rounded px-2 py-1" placeholder="兜底上游模型" defaultValue={fallback?.[1] ?? ""}
            disabled={!fallback?.[0]}
            onBlur={(e) => fallback?.[0] && api.setFallback(fallback[0], e.target.value).then(load)} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">角色识别规则</h2>
        <table className="w-full border bg-white text-sm">
          <thead><tr className="border-b text-left"><th className="p-2">模式</th><th>角色</th><th>优先级</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="p-2 font-mono">{p.pattern}</td>
                <td>{p.role}</td><td>{p.priority}</td>
                <td>{p.enabled ? "启用" : "禁用"}</td>
                <td><button className="text-red-600" onClick={() => api.deleteRolePattern(p.id).then(load)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: LogsPage（搜索 + 分页 + 展开详情）**

```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RequestLog } from "../types";

export default function LogsPage() {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const limit = 20;

  const load = () => api.listLogs(keyword || null, limit, page * limit).then(setData).catch(console.error);
  useEffect(() => { load(); }, [page]);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">请求日志</h1>
      <div className="mb-3 flex gap-2">
        <input className="border rounded px-2 py-1" placeholder="搜索 模型/渠道/TraceID/密钥"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => { setPage(0); load(); }}>搜索</button>
      </div>
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">#</th><th>时间</th><th>密钥</th><th>角色</th><th>请求模型</th><th>上游模型</th><th>渠道</th><th>状态</th><th>Token</th><th>延迟</th><th>兜底</th>
        </tr></thead>
        <tbody>
          {data.items.map((l) => (
            <>
              <tr key={l.id} className="border-b cursor-pointer hover:bg-gray-50" onClick={() => setOpen(open === l.id ? null : l.id)}>
                <td className="p-2">{l.seq}</td>
                <td>{new Date(l.created_at * 1000).toLocaleTimeString()}</td>
                <td>{l.key_name}</td>
                <td>{l.role && <span className="rounded bg-purple-100 px-1 text-xs">{l.role}</span>}</td>
                <td>{l.request_model}</td>
                <td>{l.upstream_model}</td>
                <td>{l.channel_name}</td>
                <td className={l.status_code === 200 ? "text-green-600" : "text-red-600"}>{l.status_code ?? "-"}</td>
                <td>{l.input_tokens}+{l.output_tokens}</td>
                <td>{l.latency_ms}ms</td>
                <td>{l.fallback ? "是" : ""}</td>
              </tr>
              {open === l.id && (
                <tr key={l.id + "-d"} className="border-b bg-gray-50">
                  <td colSpan={11} className="p-2">
                    <div className="text-xs text-gray-500">TraceID: {l.trace_id}{l.error && <span className="ml-2 text-red-600">{l.error}</span>}</div>
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{JSON.stringify(JSON.parse(l.request_body ?? "{}"), null, 2)}</pre>
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{l.response_body ? JSON.stringify(JSON.parse(l.response_body), null, 2) : "(无响应体 / 流式)"}</pre>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <button disabled={page === 0} className="rounded border px-2 py-1" onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page + 1} 页 / 共 {Math.max(1, Math.ceil(data.total / limit))} 页（{data.total} 条）</span>
        <button disabled={(page + 1) * limit >= data.total} className="rounded border px-2 py-1" onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 前端单测（RoleRoutesPage 渲染 + 绑定调用）**

`src/pages/__tests__/RoleRoutesPage.test.tsx`:
```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import RoleRoutesPage from "../RoleRoutesPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    listRoleRoutes: vi.fn().mockResolvedValue([
      { id: "r1", role: "sonnet", channel_id: "c1", target_model: "deepseek-v4-flash", enabled: true, updated_at: 1 },
    ]),
    listRolePatterns: vi.fn().mockResolvedValue([
      { id: "p1", pattern: "*sonnet*", role: "sonnet", priority: 100, enabled: true },
    ]),
    listChannels: vi.fn().mockResolvedValue([
      { id: "c1", name: "DeepSeek", provider_type: "deepseek", base_url: "http://x", api_key: "k", models: [], priority: 0, weight: 1, enabled: true, timeout_secs: 60, total_calls: 0, total_tokens: 0, success_rate: 1, avg_latency_ms: 0, created_at: 1, updated_at: 1 },
    ]),
    getFallback: vi.fn().mockResolvedValue(["c2", "kimi-k3"]),
    setRoleRoute: vi.fn().mockResolvedValue(undefined),
    deleteRoleRoute: vi.fn().mockResolvedValue(undefined),
    setFallback: vi.fn().mockResolvedValue(undefined),
    clearFallback: vi.fn().mockResolvedValue(undefined),
    deleteRolePattern: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("RoleRoutesPage", () => {
  it("渲染四个角色并显示已绑定的上游模型", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("fable")).toBeInTheDocument();
    expect(screen.getByText("haiku")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument()
    );
  });
});
```

`src/pages/__tests__/setup.ts`（若 vitest 需 jest-dom）:
```ts
import "@testing-library/jest-dom";
```
并在 `vite.config.ts` 的 `test` 加 `setupFiles: "./src/pages/__tests__/setup.ts"`。

- [ ] **Step 7: 跑前端测试 + typecheck + 整应用 dev 验证**

```bash
cd /Users/zhouqiao/workplace/project/llm-gateway
pnpm test:unit
pnpm typecheck
```
Expected: RoleRoutesPage 测试 PASS，typecheck 通过。

整应用联调（手动/可选）：
```bash
pnpm tauri dev   # 应用起，网关监听 127.0.0.1:8777
# 另开终端：
curl http://127.0.0.1:8777/health    # 期望 ok
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(stage1): 前端五大页面（概览/渠道/密钥/角色路由/日志）+ RoleRoutesPage单测"
```

---

## Self-Review 记录

**Spec 覆盖**：
- 渠道管理/优先级+权重/故障切换 → Task 1,3,8,12,14 ✓
- 角色路由（规则表、角色绑定、全局兜底、4xx不透传）→ Task 2,3,8,9,12,14 ✓
- 密钥配额 → Task 1,6,9,12,14 ✓
- 双协议接入 + SSE → Task 5,7,9,10 ✓
- 请求日志（全字段入库 + 搜索/筛选/展开）→ Task 1,9,12,14 ✓（高级筛选属阶段3）
- 桌面 UI 五页 → Task 13,14 ✓

**已知限制（后续阶段处理，非本阶段缺陷）**：
- 流式响应未做逐 chunk 协议转换（Anthropic 入 + OpenAI 出 的跨协议流式转换）；当前流式为同协议透传。跨协议流式转换列入阶段3增强。
- 日志高级筛选（按密钥/渠道/日期/TraceID 组合）与仪表盘图表、日志清理属阶段3。
- 安全审计、知识库、MCP、应用配置属阶段2/4/5/6。

**类型一致性**：`RouteTarget`/`plan_route`（Task 3）与 forwarder（Task 8）签名已对齐；`SseAccumulator`/`Protocol`（Task 7）与 forwarder/handlers（Task 8/9/10）一致；repository 方法名在 commands（Task 12）与 handlers（Task 9）调用一致。`Usage` 字段统一 `input_tokens`/`output_tokens`。

**Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整实现。Task 10/11 中两处标注「按编译器提示调整 acc 共享」为已知的闭包可变性实现细节，非占位——已在步骤内给出具体改法（Arc<Mutex<>>）。
