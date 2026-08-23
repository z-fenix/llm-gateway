# 整流器 + 趋势线图 + CLI JSON 编辑 + 动态模型表单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/fix.md` 的 4 项要求：整流器（Anthropic 兼容错误整流重试 + 图片降级）、所有趋势改 Recharts 线图、CLI 一键写入增加"读现有配置→编辑 JSON→写回"、渠道支持模型改动态多输入框。

**Architecture:** 整流器为唯一后端新功能——新增 `proxy/rectifier/*` 模块（配置 + 纯函数），接入 `forwarder::try_channel` 非流式路径（发送前媒体降级 + 错误整流同渠道重试一次）；其余 3 项为前端（Recharts 重写 LogTrendChart、SettingsPage CLI JSON 编辑、ChannelForm 动态模型表单）+ 两个新 Tauri 命令（`read/write_cli_config_content`）。

**Tech Stack:** Rust (axum proxy), React 18 + TypeScript + Tailwind (Tauri 前端), Recharts, Vitest。

**Spec:** `docs/superpowers/specs/2026-08-23-llm-gateway-rectifier-trends-cli-models-design.md`

## Global Constraints

- 整流器只挂非流式 `try_channel`；流式 `forward_stream` 不接入。
- 整流重试上限：对同一上游错误，signature 与 budget 至多各整流一次、合计最多一次同渠道重试；重试仍失败返回**原始错误**（继续走 failover）。
- 整流重试静默：不额外记日志、不计入 failover 统计。
- 不改表结构 / 不加迁移；整流器配置存 store.bin（键 `rectifier.*`）。
- CLI JSON 编辑：读现有配置 → 编辑 JSON → 写回（保留 `.bak`）；Codex 做 TOML↔JSON 转换。
- 每个新命令注册进 `invoke_handler!` + `src/lib/api.ts`；IPC 参数键 camelCase。
- 不引入 CodeMirror（CLI 用 textarea + JSON 校验 + 格式化）。
- `cargo test --lib`、`pnpm typecheck`、`pnpm test:unit` 全绿（e2e 若受本机系统代理 503 影响，以 `NO_PROXY=127.0.0.1,localhost` 运行并注明）。
- 前端 UI 文本用中文。
- 整流器默认值全 true（对齐 cc-switch）。

---

### Task 1: 整流器配置模块（RectifierConfig + store + AppState）

**Files:**
- Create: `src-tauri/src/proxy/rectifier/mod.rs`
- Create: `src-tauri/src/proxy/rectifier/thinking_signature.rs`（仅占位模块声明，Task 2 填充）
- Modify: `src-tauri/src/proxy/mod.rs`（`pub mod rectifier;`）
- Modify: `src-tauri/src/proxy/state.rs`（AppState 增 `rectifier` 字段）
- Modify: `src-tauri/src/lib.rs`（setup 启动时从 store.bin 加载整流器配置）
- Test: `src-tauri/src/proxy/rectifier/mod.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces: `pub struct RectifierConfig { pub enabled: bool, pub request_thinking_signature: bool, pub request_thinking_budget: bool, pub request_media_fallback: bool, pub request_media_heuristic: bool }`（`#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]`，`Default` 全 true）；`pub fn merge_from_store(mut c: RectifierConfig, values: &serde_json::Map<String, serde_json::Value>) -> RectifierConfig`（纯函数）；`pub fn get_rectifier_config(app: &tauri::AppHandle) -> RectifierConfig`（读 store.bin）；`pub fn apply_settings(state: &AppState, c: &RectifierConfig)`（写 `state.rectifier`）。
- Consumes: `crate::proxy::state::AppState`、`tauri_plugin_store::StoreExt`（`app.store("store.bin")`）。

- [ ] **Step 1: 建模块与配置结构**

创建 `src-tauri/src/proxy/rectifier/mod.rs`：

```rust
//! Anthropic 兼容性整流器配置（镜像 cc-switch RectifierConfig）。

use crate::proxy::state::AppState;
use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RectifierConfig {
    pub enabled: bool,
    pub request_thinking_signature: bool,
    pub request_thinking_budget: bool,
    pub request_media_fallback: bool,
    pub request_media_heuristic: bool,
}

impl Default for RectifierConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            request_thinking_signature: true,
            request_thinking_budget: true,
            request_media_fallback: true,
            request_media_heuristic: true,
        }
    }
}

/// 将 store 值合并进配置，缺省键保持默认。纯函数便于单测。
pub fn merge_from_store(
    mut c: RectifierConfig,
    values: &serde_json::Map<String, serde_json::Value>,
) -> RectifierConfig {
    if let Some(v) = values.get("rectifier.enabled").and_then(|v| v.as_bool()) {
        c.enabled = v;
    }
    if let Some(v) = values.get("rectifier.request_thinking_signature").and_then(|v| v.as_bool()) {
        c.request_thinking_signature = v;
    }
    if let Some(v) = values.get("rectifier.request_thinking_budget").and_then(|v| v.as_bool()) {
        c.request_thinking_budget = v;
    }
    if let Some(v) = values.get("rectifier.request_media_fallback").and_then(|v| v.as_bool()) {
        c.request_media_fallback = v;
    }
    if let Some(v) = values.get("rectifier.request_media_heuristic").and_then(|v| v.as_bool()) {
        c.request_media_heuristic = v;
    }
    c
}

/// 从 store.bin 读取整流器配置，缺省用默认值。
pub fn get_rectifier_config(app: &tauri::AppHandle) -> RectifierConfig {
    let mut c = RectifierConfig::default();
    if let Ok(store) = app.store("store.bin") {
        let mut values = serde_json::Map::new();
        for key in [
            "rectifier.enabled",
            "rectifier.request_thinking_signature",
            "rectifier.request_thinking_budget",
            "rectifier.request_media_fallback",
            "rectifier.request_media_heuristic",
        ] {
            if let Some(v) = store.get(key) {
                values.insert(key.to_string(), v);
            }
        }
        c = merge_from_store(c, &values);
    }
    c
}

/// 写整流器配置到 AppState。
pub fn apply_settings(state: &AppState, c: &RectifierConfig) {
    *state.rectifier.write() = c.clone();
}

pub mod thinking_signature;
pub mod thinking_budget;
pub mod media;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_all_true() {
        let c = RectifierConfig::default();
        assert!(c.enabled && c.request_thinking_signature && c.request_thinking_budget
            && c.request_media_fallback && c.request_media_heuristic);
    }

    #[test]
    fn merge_overrides_and_keeps_defaults() {
        let mut values = serde_json::Map::new();
        values.insert("rectifier.enabled".into(), serde_json::Value::Bool(false));
        let merged = merge_from_store(RectifierConfig::default(), &values);
        assert!(!merged.enabled);
        assert!(merged.request_thinking_signature); // 缺省键保持 true
    }

    #[test]
    fn merge_empty_keeps_defaults() {
        let merged = merge_from_store(RectifierConfig::default(), &serde_json::Map::new());
        assert_eq!(merged, RectifierConfig::default());
    }
}
```

- [ ] **Step 2: 创建 thinking_signature / thinking_budget / media 占位**

在 `src-tauri/src/proxy/rectifier/` 下创建三个空模块文件（Task 2 填充逻辑），每个先写模块注释 + 一个空的 `pub fn` 骨架（`pub fn placeholder() {}`），保证编译通过。

- [ ] **Step 3: 注册模块**

`src-tauri/src/proxy/mod.rs` 加一行 `pub mod rectifier;`。

- [ ] **Step 4: AppState 增字段**

`src-tauri/src/proxy/state.rs`：
```rust
use crate::proxy::rectifier::RectifierConfig;   // 顶部
pub rectifier: Arc<RwLock<RectifierConfig>>,    // 结构体字段（bound_addr 附近）
// AppState::new 内：
rectifier: Arc::new(RwLock::new(RectifierConfig::default())),
```

- [ ] **Step 5: lib.rs 启动加载**

`src-tauri/src/lib.rs` 的 `setup` 内，在 security 设置加载附近加：
```rust
// 从 tauri-plugin-store 加载整流器配置并同步到 AppState
let rect = crate::proxy::rectifier::get_rectifier_config(&app.handle());
crate::proxy::rectifier::apply_settings(&state, &rect);
```

- [ ] **Step 6: 运行测试**

从 `src-tauri/`：
```bash
cargo test --lib proxy::rectifier -- --nocapture
cargo test --lib 2>&1 | tail -3
cargo check
```
预期：新测试通过，全量 280+ 通过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/proxy/rectifier src-tauri/src/proxy/mod.rs src-tauri/src/proxy/state.rs src-tauri/src/lib.rs
git commit -m "feat(rectifier): 整流器配置模块(store.bin + AppState)"
```

---

### Task 2: 整流器纯函数（signature / budget / media）

**Files:**
- Modify: `src-tauri/src/proxy/rectifier/thinking_signature.rs`
- Modify: `src-tauri/src/proxy/rectifier/thinking_budget.rs`
- Modify: `src-tauri/src/proxy/rectifier/media.rs`
- Test: 各文件内 `#[cfg(test)]`

**Interfaces:**
- Consumes: `crate::proxy::rectifier::RectifierConfig`。
- Produces:
  - `pub fn should_rectify_thinking_signature(error_message: &str, cfg: &RectifierConfig) -> bool`
  - `pub fn rectify_anthropic_request(body: &mut serde_json::Value)`（返回 `()`；内部原地改）
  - `pub fn should_rectify_thinking_budget(error_message: &str, cfg: &RectifierConfig) -> bool`
  - `pub fn rectify_thinking_budget(body: &mut serde_json::Value) -> bool`（返回是否有变化）
  - `pub fn is_text_only_model(model: &str) -> bool`（内置纯文本模型注册表）
  - `pub fn apply_media_prevention(body: &mut serde_json::Value, model: &str, cfg: &RectifierConfig) -> bool`（返回是否修改）

- [ ] **Step 1: thinking_signature.rs 实现**

```rust
//! 处理 Anthropic "Invalid 'signature' in 'thinking' block" 类错误：判定 + 请求体整流。

use super::RectifierConfig;

/// 对错误消息做小写子串匹配，命中 signature 相关场景。
pub fn should_rectify_thinking_signature(error_message: &str, cfg: &RectifierConfig) -> bool {
    if !cfg.enabled || !cfg.request_thinking_signature {
        return false;
    }
    let m = error_message.to_lowercase();
    [
        "invalid 'signature' in 'thinking' block",
        "signature" .to_string() + " in " + "thinking" + " block",
    ]
    .iter()
    .any(|s| m.contains(s))
        || (m.contains("invalid") && m.contains("signature") && m.contains("thinking") && m.contains("block"))
        || m.contains("must start with a thinking block")
        || m.contains("expected")
            && m.contains("found tool_use")
            && m.contains("thinking")
}

/// 原地修改 Anthropic 请求体：删 thinking/redacted_thinking block、去 signature。
pub fn rectify_anthropic_request(body: &mut serde_json::Value) {
    if let Some(msgs) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in msgs {
            if let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                content.retain(|block| {
                    !matches!(
                        block.get("type").and_then(|t| t.as_str()),
                        Some("thinking") | Some("redacted_thinking")
                    )
                });
                for block in content.iter_mut() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("thinking") {
                        if let serde_json::Value::Object(map) = block {
                            map.remove("signature");
                        }
                    }
                }
            }
        }
    }
    // 兜底：删除顶层 thinking 字段
    if let serde_json::Value::Object(map) = body {
        map.remove("thinking");
    }
}
```

- [ ] **Step 2: thinking_signature.rs 单测**

覆盖：命中（完整 signature 错误串、大小写、组合词）、未命中（无关错误）、`cfg.request_thinking_signature=false` 时返回 false、`rectify_anthropic_request` 删除 thinking block 与 signature、保留正常 text block、无 thinking 时 body 不变（或仅删顶层字段）。

- [ ] **Step 3: thinking_budget.rs 实现**

```rust
//! 处理 Anthropic thinking budget 约束错误：判定 + budget 整流。

use super::RectifierConfig;

pub fn should_rectify_thinking_budget(error_message: &str, cfg: &RectifierConfig) -> bool {
    if !cfg.enabled || !cfg.request_thinking_budget {
        return false;
    }
    let m = error_message.to_lowercase();
    m.contains("budget") && (m.contains("thinking") || m.contains("max_tokens"))
}

/// 修改 body 的 thinking.budget_tokens：若存在则移除 budget_tokens（改为 enabled 无 budget）。
/// 返回是否有变化。
pub fn rectify_thinking_budget(body: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(thinking) = body.get_mut("thinking").and_then(|t| t.as_object_mut()) {
        if thinking.contains_key("budget_tokens") {
            thinking.remove("budget_tokens");
            changed = true;
        }
    }
    changed
}
```

- [ ] **Step 4: thinking_budget.rs 单测**

覆盖：命中 budget+thinking 错误、未命中、`cfg` 关闭、`rectify_thinking_budget` 移除 budget_tokens 且返回 true、无 thinking 时返回 false。

- [ ] **Step 5: media.rs 实现**

```rust
//! 图片降级：发送前对纯文本模型把 image block 替换为 [Unsupported Image]。

use super::RectifierConfig;

/// 内置纯文本模型注册表（无视觉能力的模型）。
pub fn is_text_only_model(model: &str) -> bool {
    let m = model.to_lowercase();
    ["claude-3-haiku", "claude-3-opus", "claude-haiku", "deepseek", "gpt-4o-mini"]
        .iter()
        .any(|s| m.contains(s))
}

/// 发送前媒体降级：heuristic 开启且模型为纯文本时，把 image block 替换为文本标记。
/// 返回是否有修改。
pub fn apply_media_prevention(
    body: &mut serde_json::Value,
    model: &str,
    cfg: &RectifierConfig,
) -> bool {
    if !cfg.enabled || !cfg.request_media_fallback || !cfg.request_media_heuristic {
        return false;
    }
    if !is_text_only_model(model) {
        return false;
    }
    let mut changed = false;
    if let Some(msgs) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in msgs {
            if let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) {
                for block in content.iter_mut() {
                    if block.get("type").and_then(|t| t.as_str()) == Some("image") {
                        *block = serde_json::json!({
                            "type": "text",
                            "text": "[Unsupported Image]"
                        });
                        changed = true;
                    }
                }
            }
        }
    }
    changed
}
```

- [ ] **Step 6: media.rs 单测**

覆盖：纯文本模型图片替换、非纯文本模型不动、heuristic 关闭不动、`is_text_only_model` 命中/未命中。

- [ ] **Step 7: 运行测试**

```bash
cd src-tauri
cargo test --lib proxy::rectifier -- --nocapture
cargo test --lib 2>&1 | tail -3
cargo check
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/proxy/rectifier
git commit -m "feat(rectifier): 整流器纯函数(signature/budget/media)"
```

---

### Task 3: 整流器接入 try_channel（媒体降级 + 错误整流重试）

**Files:**
- Modify: `src-tauri/src/proxy/forwarder.rs`（`try_channel` 拆分 + 接入整流器）
- Create: `src-tauri/tests/rectifier.rs`（集成测试）
- Modify: `src-tauri/tests/common/mod.rs`（如需：mock 支持「第一次返回错误、第二次返回 200」——见 Step 3）

**Interfaces:**
- Consumes: `crate::proxy::rectifier::{media, thinking_budget, thinking_signature}`、`RectifierConfig`、`AppState.rectifier`。
- Produces: `try_channel` 行为变化：Anthropic 渠道发送前媒体降级；收到 signature/budget 错误时整流重试一次。

- [ ] **Step 1: 提取 send_once 辅助**

在 `forwarder.rs` 的 `try_channel` 内，把「构建 req + send + 读 text」抽成私有辅助：

```rust
/// 发送一次上游请求，返回 (status, body_text)。Http 级错误返回 ForwardError::Http。
async fn send_once(
    state: &AppState,
    ch: &Channel,
    url: &str,
    body: &serde_json::Value,
) -> Result<(u16, String), ForwardError> {
    let mut req = state
        .http
        .post(url)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
    if let Some((hname, hval)) = auth_header(&ch.upstream_protocol, &ch.api_key) {
        req = req.header(hname, hval);
    }
    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| ForwardError::Http(e.to_string()))?;
    Ok((status, text))
}
```

- [ ] **Step 2: 改写 try_channel 接入整流器**

`try_channel` 改为：

```rust
async fn try_channel(
    state: &AppState,
    ch: &Channel,
    model: &str,
    chat: &ChatRequest,
) -> Result<(u16, serde_json::Value, Usage), ForwardError> {
    let url = upstream_url(&ch.upstream_protocol, &ch.base_url, model, &ch.api_key, chat.stream);
    let mut body = build_upstream_body(chat, &ch.upstream_protocol, model);
    let cfg = state.rectifier.read().clone();

    // 发送前媒体降级（仅 Anthropic 上游）
    if ch.upstream_protocol == "anthropic-messages" {
        crate::proxy::rectifier::media::apply_media_prevention(&mut body, model, &cfg);
    }

    let (status, text) = send_once(state, ch, &url, &body).await?;
    if status != 200 {
        // 整流重试（仅 Anthropic 上游）：signature 优先，否则 budget；合计最多一次
        if ch.upstream_protocol == "anthropic-messages" {
            let before = body.clone();
            if crate::proxy::rectifier::thinking_signature::should_rectify_thinking_signature(&text, &cfg) {
                crate::proxy::rectifier::thinking_signature::rectify_anthropic_request(&mut body);
            } else if crate::proxy::rectifier::thinking_budget::should_rectify_thinking_budget(&text, &cfg) {
                crate::proxy::rectifier::thinking_budget::rectify_thinking_budget(&mut body);
            }
            if body != before {
                let (status2, text2) = send_once(state, ch, &url, &body).await?;
                if status2 == 200 {
                    return Ok((status2, parse_body(&text2), extract_usage(ch, &text2)));
                }
                // 重试仍失败：返回原始错误，继续 failover
                return Err(ForwardError::Upstream { status, body: text });
            }
        }
        return Err(ForwardError::Upstream { status, body: text });
    }
    Ok((status, parse_body(&text), extract_usage(ch, &text)))
}
```

同时把原 try_channel 里的「parse + extract usage」拆成两个私有辅助（`fn parse_body(text: &str) -> serde_json::Value` 与 `fn extract_usage(ch: &Channel, text: &str) -> Usage`，内容搬自现逻辑），避免重复。

- [ ] **Step 3: 集成测试 tests/rectifier.rs**

在 `src-tauri/tests/common/mod.rs` 增加 `spawn_rectifier_mock(first_status, first_body, second_status, second_body)`：一个 mock 上游，第一次 POST 返回 `(first_status, first_body)`，第二次返回 `(second_status, second_body)`，并记录每次收到的请求体（`hits: Vec<Value>`），供断言第二次请求体已整流。

`src-tauri/tests/rectifier.rs`：
```rust
mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn channel(id: &str, base: &str) -> Channel {
    Channel {
        id: id.into(), name: id.into(), supplier: "anthropic".into(),
        upstream_protocol: "anthropic-messages".into(),
        base_url: base.into(), api_key: "sk-test".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 5,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}
```
测试用例：
1. `signature_error_triggers_rectify_and_retry`：mock 第一次返回 400 + body `{"error":{"message":"Invalid 'signature' in 'thinking' block"}}`，第二次 200 + 正常 Anthropic 响应；发送含 thinking block 的 `/v1/messages` 请求；断言最终 200、mock 收到 2 次请求、第二次请求体 messages[].content 无 `type=="thinking"` block。
2. `unrectifiable_error_returns_original`：mock 第一次 400 + 无关错误；断言响应 400 且只收到 1 次请求。
3. `media_fallback_strips_images`：mock 200；发送含 `type=="image"` block 的请求 + `model:"claude-3-haiku-20240307"`；断言收到的请求体 image 被替换为 `[Unsupported Image]`。

运行（若受本机代理影响用 `NO_PROXY=127.0.0.1,localhost`）：
```bash
NO_PROXY=127.0.0.1,localhost cargo test --test rectifier -- --nocapture
cargo test --lib 2>&1 | tail -3
cargo check
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/proxy/forwarder.rs src-tauri/tests/rectifier.rs src-tauri/tests/common/mod.rs
git commit -m "feat(rectifier): 接入非流式转发(媒体降级+错误整流重试)"
```

---

### Task 4: 整流器命令 + 前端 API + SettingsPage 整流器 Card

**Files:**
- Create: `src-tauri/src/commands/rectifier.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod rectifier;`）
- Modify: `src-tauri/src/lib.rs`（注册命令）
- Modify: `src/lib/api.ts`
- Modify: `src/pages/SettingsPage.tsx`（整流器 Card）
- Modify: `src/pages/__tests__/SettingsPage.test.tsx`（整流器开关测试）
- Test: `cargo test --lib commands::rectifier`（如可测）+ `pnpm test:unit`

**Interfaces:**
- Consumes: `crate::proxy::rectifier::{RectifierConfig, get_rectifier_config, apply_settings}`、`AppState`。
- Produces: `#[tauri::command] pub fn get_rectifier_config(state: State<AppState>) -> RectifierConfig`；`#[tauri::command] pub fn set_rectifier_config(state: State<AppState>, app: AppHandle, key: String, value: bool) -> Result<(), String>`；前端 `api.getRectifierConfig()` / `api.setRectifierConfig(key, value)`。

- [ ] **Step 1: 命令**

```rust
use crate::proxy::rectifier::{get_rectifier_config, RectifierConfig};
use crate::proxy::state::AppState;
use serde_json::json;
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

#[tauri::command]
pub fn get_rectifier_config(state: State<AppState>) -> RectifierConfig {
    state.rectifier.read().clone()
}

#[tauri::command]
pub fn set_rectifier_config(
    state: State<AppState>,
    app: AppHandle,
    key: String,
    value: bool,
) -> Result<(), String> {
    let valid = ["enabled", "request_thinking_signature", "request_thinking_budget",
        "request_media_fallback", "request_media_heuristic"];
    if !valid.contains(&key.as_str()) {
        return Err(format!("invalid rectifier key: {key}"));
    }
    let mut cfg = state.rectifier.read().clone();
    match key.as_str() {
        "enabled" => cfg.enabled = value,
        "request_thinking_signature" => cfg.request_thinking_signature = value,
        "request_thinking_budget" => cfg.request_thinking_budget = value,
        "request_media_fallback" => cfg.request_media_fallback = value,
        _ => cfg.request_media_heuristic = value,
    }
    *state.rectifier.write() = cfg.clone();
    if let Ok(store) = app.store("store.bin") {
        let _ = store.set(format!("rectifier.{key}"), json!(value));
        if let Err(e) = store.save() {
            log::error!("failed to save rectifier config: {e}");
        }
    }
    Ok(())
}
```
`commands/mod.rs` 加 `pub mod rectifier;`；`lib.rs` 的 `invoke_handler!` 注册两个命令。

- [ ] **Step 2: api.ts**

```ts
getRectifierConfig: () => invoke<RectifierConfig>("get_rectifier_config"),
setRectifierConfig: (key: string, value: boolean) =>
  invoke<void>("set_rectifier_config", { key, value }),
```
`src/types/index.ts` 加：
```ts
export interface RectifierConfig {
  enabled: boolean;
  request_thinking_signature: boolean;
  request_thinking_budget: boolean;
  request_media_fallback: boolean;
  request_media_heuristic: boolean;
}
```

- [ ] **Step 3: SettingsPage 整流器 Card**

在 `src/pages/SettingsPage.tsx` 增一个 `Card`（放在端口配置之后、CLI 之前）：「整流器」标题 + 描述「Anthropic 兼容性错误自动整流重试与图片降级」。5 行，每行 `Label` + `text-xs text-muted-foreground` 描述 + `Switch`（用 `ui/switch.tsx`）。状态 `rectifier: RectifierConfig`，挂载时 `api.getRectifierConfig()`；`onCheckedChange` → 乐观更新本地 state + `api.setRectifierConfig(key, v)`，失败 `toast.error` 并回滚。
- 总开关 disabled 时 4 个子开关 disabled。
- `request_media_heuristic` 行在 `request_media_fallback` 关闭时 disabled。
- 行文案（中文）：总开关「启用整流器」；「修复 thinking signature 错误」「删除 thinking 块并重试」；「修复 thinking budget 错误」「调整 budget_tokens 并重试」；「图片降级（总开关）」；「发送前剥离图片（纯文本模型）」。

- [ ] **Step 4: SettingsPage 测试**

`src/pages/__tests__/SettingsPage.test.tsx` 追加：mock `api.getRectifierConfig` 返回默认；断言「整流器」「修复 thinking signature 错误」渲染；点击「启用整流器」Switch → 断言 `api.setRectifierConfig("enabled", false)`（mock 初始 true，参照 SecurityPage 测试的 radix Switch 交互模式）。

- [ ] **Step 5: 运行验证**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -3
cd .. && pnpm typecheck && pnpm test:unit
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/rectifier.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/api.ts src/types/index.ts src/pages/SettingsPage.tsx src/pages/__tests__/SettingsPage.test.tsx
git commit -m "feat(rectifier): 命令+前端 API+设置页整流器开关"
```

---

### Task 5: 趋势图 Recharts 线图重写

**Files:**
- Modify: `package.json`（`pnpm add recharts`）
- Modify: `src/components/LogTrendChart.tsx`（Recharts 重写）
- Modify: `src/components/__tests__/LogTrendChart.test.tsx`
- Modify: `src/pages/__tests__/DashboardPage.test.tsx`、`src/pages/__tests__/LogsPage.test.tsx`（若引用旧 chart 内部结构）
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `TimeBucket { bucket, calls, input_tokens, output_tokens, error_count, risk_counts }`、`Dimension = "calls" | "tokens" | "success" | "risk"`。
- Produces: 保持对外 `LogTrendChart({ buckets, dimension, bucketSecs })` 与导出 `Dimension`、`niceCeil`、`formatBucketLabel` 不变（供 Dashboard/Logs 复用）。

- [ ] **Step 1: 安装 recharts**

```bash
pnpm add recharts
```

- [ ] **Step 2: 重写 LogTrendChart.tsx**

保持导出 `Dimension`、`niceCeil`、`formatBucketLabel`。核心：

```tsx
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "../lib/utils";

const RISK_ORDER = ["clean", "info", "low", "medium", "high", "critical"];
const RISK_COLORS: Record<string, string> = {
  clean: "#9ca3af", info: "#3b82f6", low: "#22c55e", medium: "#eab308",
  high: "#f97316", critical: "#ef4444",
};

export default function LogTrendChart({ buckets, dimension, bucketSecs }: {
  buckets: TimeBucket[]; dimension: Dimension; bucketSecs: number;
}) {
  const chartData = useMemo(() =>
    buckets.map((b) => ({
      label: formatBucketLabel(bucketSecs, b.bucket * 1000),
      calls: b.calls,
      input: b.input_tokens,
      output: b.output_tokens,
      success: b.calls === 0 ? 0 : Math.round(((b.calls - b.error_count) / b.calls) * 1000) / 10,
      ...Object.fromEntries(RISK_ORDER.map((l) => [l, b.risk_counts[l] || 0])),
    })),
    [buckets, bucketSecs]
  );

  if (buckets.length === 0) {
    return <div className="flex h-[180px] w-full items-center justify-center rounded border border-dashed border-gray-300 bg-muted text-sm text-muted-foreground">暂无数据</div>;
  }

  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            {/* input/output 同款渐变，id 分别为 colorInput/colorOutput */}
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} dy={10} />
          <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            tickFormatter={(v: number) => (dimension === "success" ? `${v}%` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))}
            width={44} />
          <Tooltip content={<CustomTooltip dimension={dimension} />} />
          {dimension === "calls" && <Area type="monotone" dataKey="calls" name="调用量" stroke="#3b82f6" strokeWidth={2} fill="url(#colorCalls)" />}
          {dimension === "tokens" && (
            <>
              <Area type="monotone" dataKey="input" name="输入 Tokens" stroke="#3b82f6" strokeWidth={2} fill="url(#colorInput)" />
              <Area type="monotone" dataKey="output" name="输出 Tokens" stroke="#22c55e" strokeWidth={2} fill="url(#colorOutput)" />
            </>
          )}
          {dimension === "success" && <Area type="monotone" dataKey="success" name="成功率" stroke="#22c55e" strokeWidth={2} fill="none" />}
          {dimension === "risk" && RISK_ORDER.map((l) => (
            <Area key={l} type="monotone" dataKey={l} name={l} stackId="risk"
              stroke={RISK_COLORS[l]} fill={RISK_COLORS[l]} fillOpacity={0.6} strokeWidth={1} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

`CustomTooltip`（dimension 感知，容器 `rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-md`，彩色圆点 + name + 值）。`niceCeil`/`formatBucketLabel` 若原测试直接 import 则保留导出。

- [ ] **Step 3: 更新测试**

`LogTrendChart.test.tsx`：原断言改为——mock `recharts` 或断言渲染结构。**建议做法**：由于 Recharts 在 jsdom 用 `ResponsiveContainer` 常渲染空，测试改为「mock recharts 组件」：
```tsx
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive">{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="chart">{children}</div>,
  Area: () => <div data-testid="area" />,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));
```
然后断言：空数据渲染「暂无数据」；calls 维度渲染 1 个 area；tokens 渲染 2 个 area；risk 渲染 6 个 area（stackId="risk" 的存在通过 `data-testid="area"` 数量断言）。若该文件现有测试以「canvas/bar」方式断言，整体重写为上述结构断言。`DashboardPage.test.tsx` / `LogsPage.test.tsx` 若断言 `trend-chart` data 属性，保持组件的 `data-testid="trend-chart"`（若有）或更新查询。

- [ ] **Step 4: 运行验证**

```bash
pnpm typecheck
pnpm test:unit
```
预期全绿。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/LogTrendChart.tsx src/components/__tests__/LogTrendChart.test.tsx src/pages/__tests__/DashboardPage.test.tsx src/pages/__tests__/LogsPage.test.tsx
git commit -m "feat(ui): 趋势图改用 Recharts 线图(所有维度)"
```

---

### Task 6: CLI 配置 JSON 编辑命令（read/write_cli_config_content）

**Files:**
- Create: `src-tauri/src/commands/cli.rs`
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod cli;`）
- Modify: `src-tauri/src/lib.rs`（注册命令）
- Modify: `src/lib/api.ts`
- Modify: `src-tauri/src/cli_config/mod.rs`（暴露 `read_opt` 或加公共读函数，供 cli.rs 复用）
- Test: `cargo test --lib commands::cli`

**Interfaces:**
- Consumes: `cli_config::{claude_code, codex}`、`backup_and_write`、`CliWriteResult`、`dirs::home_dir`。
- Produces:
  - `#[tauri::command] pub fn read_cli_config(target: String) -> Result<String, String>`：返回 JSON 文本（Claude Code 原样 settings.json；Codex TOML→JSON）。
  - `#[tauri::command] pub fn write_cli_config_content(target: String, json_content: String) -> Result<CliWriteResult, String>`：校验 JSON 对象；写回（保留 `.bak`）。
  - 前端 `api.readCliConfig(target)` / `api.writeCliConfigContent(target, jsonContent)`。

- [ ] **Step 1: cli_config/mod.rs 暴露读取辅助**

在 `cli_config/mod.rs` 把 `fn read_opt(path: &Path)` 改为 `pub fn read_opt(path: &Path) -> Result<Option<String>, String>`（现有 claude_code.rs / codex.rs 各有私有 `read_opt`，可统一用公共版；不改它们行为即可，新增 cli.rs 用 `super::read_opt`）。若嫌改动面大，就在 cli.rs 内自建 `fn read_file(path) -> Result<Option<String>, String>`（复制 read_opt 逻辑），不触碰现有模块。

- [ ] **Step 2: commands/cli.rs**

```rust
use crate::cli_config::{backup_and_write, claude_code, codex, CliWriteResult};
use std::path::PathBuf;

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定用户主目录".to_string())
}

fn read_file(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(c) => Ok(Some(c)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

/// 读取现有 CLI 配置为 JSON 文本供前端编辑。
#[tauri::command]
pub fn read_cli_config(target: String) -> Result<String, String> {
    let h = home()?;
    match target.as_str() {
        "claude_code" => {
            let p = claude_code::settings_path(&h);
            let content = read_file(&p)?.unwrap_or_else(|| "{}".to_string());
            // 若当前内容非法 JSON，返回 {} 而非报错（便于从空白开始编辑）
            serde_json::from_str::<serde_json::Value>(&content)
                .map(|_| content)
                .unwrap_or_else(|_| "{}".to_string())
        }
        "codex" => {
            let p = codex::config_path(&h);
            let content = read_file(&p)?.unwrap_or_default();
            let v: toml::Value = if content.trim().is_empty() {
                toml::Value::Table(toml::map::Map::new())
            } else {
                toml::from_str(&content).map_err(|e| format!("parse config.toml: {e}"))?
            };
            serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}

/// 校验并写回 CLI 配置（保留备份）。
#[tauri::command]
pub fn write_cli_config_content(target: String, json_content: String) -> Result<CliWriteResult, String> {
    let v: serde_json::Value =
        serde_json::from_str(&json_content).map_err(|e| format!("JSON 解析失败: {e}"))?;
    if !v.is_object() {
        return Err("配置必须是 JSON 对象".into());
    }
    let h = home()?;
    match target.as_str() {
        "claude_code" => {
            let sp = claude_code::settings_path(&h);
            let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
            let backup = backup_and_write(&sp, &pretty)?;
            // 保持 .claude.json onboarding 处理
            let dp = claude_code::dotclaude_path(&h);
            let dcontent = claude_code::merge_dotclaude(read_file(&dp)?.as_deref())?.0;
            let dbackup = backup_and_write(&dp, &dcontent)?;
            Ok(CliWriteResult {
                path: sp.display().to_string(),
                changed_keys: vec!["env".to_string()],
                backup_path: backup,
                env_instructions: None,
            })
            // 注：dbackup 暂不展示（与现有 write 行为一致展示主文件备份）
        }
        "codex" => {
            let toml_val = toml::Value::try_from(v).map_err(|e| format!("JSON→TOML 转换失败: {e}"))?;
            let content = toml::to_string_pretty(&toml_val).map_err(|e| e.to_string())?;
            let cp = codex::config_path(&h);
            let backup = backup_and_write(&cp, &content)?;
            Ok(CliWriteResult {
                path: cp.display().to_string(),
                changed_keys: vec![],
                backup_path: backup,
                env_instructions: None,
            })
        }
        other => Err(format!("未知 CLI 目标: {other}")),
    }
}
```

注意：`toml::Value::try_from(serde_json::Value)` 需确认 toml 1.1.4 支持（`toml::Value: TryFrom<serde_json::Value>`，`json` feature 默认开启）。若编译报错，用 `serde_json::from_value::<toml::Value>(v)` 转换（serde 支持 toml::Value 反序列化自 JSON——验证后二选一）。`CliWriteResult` 需要字段可见（已在 `cli_config/mod.rs` 定义 `pub struct`，字段 pub）。

`commands/mod.rs` 加 `pub mod cli;`；`lib.rs` 注册 `commands::cli::read_cli_config`、`commands::cli::write_cli_config_content`。

- [ ] **Step 3: api.ts + types**

```ts
readCliConfig: (target: string) => invoke<string>("read_cli_config", { target }),
writeCliConfigContent: (target: string, jsonContent: string) =>
  invoke<CliWriteResult>("write_cli_config_content", { target, jsonContent }),
```
`CliWriteResult` 类型已存在于 `types/index.ts`。

- [ ] **Step 4: 单测**

`commands/cli.rs` 内 `#[cfg(test)]`：
- `read_cli_config_claude_code_roundtrip`：用 tempdir 写 `settings.json`，调内部辅助（把 `home()` 做成可注入——命令是 `#[tauri::command]`，测试直接测 `read_cli_config_with_home(&h, target)` / `write_cli_config_content_with_home(&h, target, json)` 辅助函数）。
- `read_cli_config_codex_toml_to_json`：tempdir 写 `config.toml`，断言 JSON 含 model_provider。
- `write_cli_config_content_rejects_non_object`：非对象 JSON → Err。
- `write_cli_config_content_codex_json_to_toml`：写 JSON → 读回 TOML 解析成功。
- `write_cli_config_content_creates_backup`：已存在文件 → 写回 → `.bak` 存在。

实现时把命令逻辑拆成 `*_with_home(home, ...)` 辅助 + 薄 `#[tauri::command]` 包装（沿用本仓库 `_with_state` 测试模式）。

- [ ] **Step 5: 运行验证**

```bash
cd src-tauri && cargo test --lib commands::cli -- --nocapture && cargo test --lib 2>&1 | tail -3 && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/cli.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(cli): 读现有配置 JSON 编辑写回命令(read/write_cli_config_content)"
```

---

### Task 7: SettingsPage CLI JSON 编辑 UI

**Files:**
- Modify: `src/pages/SettingsPage.tsx`（CLI 卡内加「编辑配置」）
- Modify: `src/pages/__tests__/SettingsPage.test.tsx`（CLI 编辑测试）
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.readCliConfig(target)` / `api.writeCliConfigContent(target, jsonContent)`。

- [ ] **Step 1: SettingsPage CLI 卡加「编辑配置」**

在现有 CLI 一键写入卡（目标 Select + 密钥 Select + 一键写入按钮）下方加：
- 「编辑配置」`Button`（outline）→ 展开一个区域（或 Dialog）：
  - 顶部：当前目标标签 + Codex 时标注「config.toml（将转为 JSON 编辑）」。
  - `textarea`（`min-h-[240px] font-mono text-xs`），值 = `cliJson` state，`onChange` 实时更新。
  - 校验：`try { JSON.parse(cliJson) } catch { 显示红字「JSON 格式错误」}`，不阻断保存但提示。
  - 「格式化」按钮：`setCliJson(JSON.stringify(JSON.parse(cliJson), null, 2))`（解析失败则 toast.error）。
  - 「保存」按钮：`api.writeCliConfigContent(target, cliJson)` → 成功 `toast.success("CLI 配置已保存")` + 刷新 `getCliTargets`；失败 `toast.error`。
  - 「重新加载」按钮：重新 `readCliConfig(target)`。
- 交互：点击「编辑配置」时 `readCliConfig(target)` 填充 `cliJson`；切换 target 时若已展开则重新读取。

- [ ] **Step 2: SettingsPage 测试**

`SettingsPage.test.tsx` 追加：
- mock `api.readCliConfig` 返回 `{"env":{"A":"1"}}`；点击「编辑配置」→ 断言 textarea 出现且值含 `"A"`。
- 输入非法 JSON（如 `{bad`）→ 断言出现「JSON 格式错误」。
- 输入合法 JSON + 点击保存 → 断言 `api.writeCliConfigContent` 被调用且参数为 `(target, 合法内容)`。
- 格式化按钮：输入压缩 JSON → 点击 → 断言 textarea 值被美化。

- [ ] **Step 3: 运行验证**

```bash
pnpm typecheck && pnpm test:unit
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/SettingsPage.tsx src/pages/__tests__/SettingsPage.test.tsx
git commit -m "feat(ui): 设置页 CLI 配置 JSON 编辑器(读→编辑→写回)"
```

---

### Task 8: ChannelForm 动态模型多输入框

**Files:**
- Modify: `src/components/ChannelForm.tsx`
- Modify: `src/components/__tests__/ChannelForm.test.tsx`
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `f.models: string[]`（表单 state，`set("models", ...)`）。
- Produces: 动态多输入框 UI；提交仍以 `models: string[]` 传给 `onSubmit(f as Channel)`（对外接口不变）。

- [ ] **Step 1: 动态模型列表**

在 `ChannelForm.tsx`：
- 用 `useRef<string[]>([])` 存 `modelKeys`（初始为 `initial?.models ?? []` 长度的随机 key 数组）。挂载时若 `modelKeys.current.length !== (f.models ?? []).length`，重置为对应长度。
- 渲染：
```tsx
<div className="space-y-2">
  <Label>支持模型</Label>
  {(f.models ?? []).map((m, i) => (
    <div key={modelKeys[i] ?? `m${i}`} className="flex items-center gap-2">
      <Input value={m} onChange={(e) => updateModel(i, e.target.value)} placeholder="模型 ID，如 deepseek-chat" />
      <Button type="button" variant="ghost" size="icon" onClick={() => removeModel(i)} aria-label="删除模型">
        <Trash2 size={16} />
      </Button>
    </div>
  ))}
  <Button type="button" variant="outline" size="sm" onClick={addModel}>
    <Plus size={16} /> 添加模型
  </Button>
  {errMsg("models")}
</div>
```
- 辅助：
```ts
const addModel = () => {
  modelKeys.current.push(crypto.randomUUID());
  set("models", [...(f.models ?? []), ""]);
};
const removeModel = (i: number) => {
  modelKeys.current.splice(i, 1);
  const next = [...(f.models ?? [])];
  next.splice(i, 1);
  set("models", next);
};
const updateModel = (i: number, v: string) => {
  const next = [...(f.models ?? [])];
  next[i] = v;
  set("models", next);
};
```
- `crypto.randomUUID` 在测试 jsdom 可用性：若不可用，`vi.stubGlobal("crypto", { randomUUID: () => ... })` 或组件内回退 `Math.random().toString(36)`。为稳妥，用 `const uid = () => crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);`。
- `Trash2` / `Plus` 从 `lucide-react` 导入（已依赖）。
- 删除旧的「逗号分隔」Input（`id="channel-models"` 及其 split 逻辑）。

- [ ] **Step 2: 更新测试**

`ChannelForm.test.tsx`：原「逗号分隔输入」交互（若有）改为——点击「添加模型」→ 出现新 Input → 输入值 → 提交断言 `onSubmit` 收到 `models: ["value"]`；「至少需要一个模型」校验仍触发（空列表提交 → 红字）。`validateForm` 的 models 规则（`some((m) => m.trim())`）保持不变，测试继续断言。

- [ ] **Step 3: 运行验证**

```bash
pnpm typecheck && pnpm test:unit
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ChannelForm.tsx src/components/__tests__/ChannelForm.test.tsx
git commit -m "feat(ui): 渠道支持模型动态多输入框(可增删)"
```

---

## 验收

- `cargo test --lib` 全绿（280+ 现有 + 新增整流器/cli 测试）。
- `cargo test --test rectifier`（`NO_PROXY=127.0.0.1,localhost`）通过。
- `pnpm typecheck` + `pnpm test:unit` 全绿。
- `pnpm dev` 手动验证（可选）：SettingsPage 整流器开关生效；趋势图为线图；CLI 可读现有配置编辑写回；渠道表单可动态增删模型。
