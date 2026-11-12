# 图片模型角色实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 新增合成角色 `image`：请求含图像（图片识别）时，把请求路由到配置的 `image` 角色渠道/模型；上游返回「不支持图像」时也能重路由到该角色。前端角色路由页可配置 `image` 角色的渠道与模型。

**Architecture:** 与现有 `auto` 一样是合成角色（不改 schema，只在 `role_routes` 配 `role='image'`）。请求侧在 `proxy/handlers.rs` 角色探测处检测 `chat.messages` 是否含图像块，命中则把角色覆盖为 `image`；错误侧在 `proxy/forwarder.rs` 的错误分支检测「不支持图像」错误体，触发一次 `image` 角色重规划。Responses/Gemini 的 `request_to_chat` 需保留图像块以便请求侧可检测。

**Tech Stack:** Rust（axum/reqwest/serde_json）、React/TS（角色路由页）。

**Spec:** `docs/superpowers/specs/2026-08-26-tabs-project-dimension-image-design.md`（子项目 C 部分）

## Global Constraints

- 角色字符串 `image`：合成，不新增 `role_patterns`（它是内容驱动，非模型名匹配）。
- `role_routes` 表已支持任意 role 字符串；无需迁移。
- 前端 `src/lib/roleSort.ts` 的 `ROLE_ORDER` 与 `RoleRoutesPage.tsx` 的 `ROLE_COLORS` 增加 `image`。
- 提交前：`cargo test --lib`、`pnpm typecheck`、`pnpm test:unit`；提交走项目 code-review 门禁。
- 提交信息：`feat(routing): 图片模型角色（含图请求路由到 image 角色）`。

---

### Task 1: 图像检测 `is_image_request` + 请求侧角色覆盖

**Files:**
- Modify: `src-tauri/src/router/role.rs`（新增 `is_image_request`）
- Test: `src-tauri/src/router/role.rs`（`#[cfg(test)]`）
- Modify: `src-tauri/src/proxy/handlers.rs`（约 335-341 角色探测处覆盖为 image）
- Modify: `src-tauri/src/proxy/forwarder.rs`（`build_candidates` 已有的任意 role 处理无需改）

**Interfaces:**
- Produces: `pub fn is_image_request(chat: &ChatRequest) -> bool` — 遍历 `chat.messages[].content`（`serde_json::Value`），若任一消息 content 满足以下任一条件返回 true：
  - content 是数组，且某块的 `type` 字段为 `"image"`（Anthropic/Gemini 风格）或 `"image_url"`（OpenAI 风格）；
  - 或某块含 `image_url` 对象（`{ "type":"text", ... }` 之外，存在 `"image_url"` 键）。
  注意 content 可能是 string（纯文本）或 array；string 直接跳过。
- Consumes: `crate::protocol::types::ChatRequest`。

- [ ] **Step 1: 写失败测试**（`role.rs` 新增 `#[cfg(test)]` 模块）

```rust
#[cfg(test)]
mod image_tests {
    use super::*;
    use crate::protocol::types::{ChatRequest, ChatMessage};
    use serde_json::json;

    fn chat(content: serde_json::Value) -> ChatRequest {
        ChatRequest {
            model: "gpt-4o".into(),
            messages: vec![ChatMessage { role: "user".into(), content }],
            max_tokens: None, stream: false, temperature: None, tools: None, extra: Default::default(),
        }
    }

    #[test]
    fn detects_openai_image_url() {
        let c = chat(json!([{"type":"text","text":"看这个"},{"type":"image_url","image_url":{"url":"http://a/b.png"}}]));
        assert!(is_image_request(&c));
    }
    #[test]
    fn detects_anthropic_image_block() {
        let c = chat(json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"x"}}]));
        assert!(is_image_request(&c));
    }
    #[test]
    fn plain_text_is_not_image() {
        assert!(!is_image_request(&chat(json!("hello"))));
        assert!(!is_image_request(&chat(json!([{"type":"text","text":"only text"}]))));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --lib router::role::image_tests -- --nocapture`
Expected: FAIL（`is_image_request` 未定义）。

- [ ] **Step 3: 实现 `is_image_request`**

在 `role.rs` 中新增（`detect_role` 之后）：

```rust
/// 判断统一请求是否含图像内容（用于把角色覆盖为 `image`）。
/// content 可能为纯文本字符串或数组；数组块可能是 Anthropic/Gemini 的
/// `type=="image"`、OpenAI 的 `type=="image_url"`，或含 `image_url` 键。
pub fn is_image_request(chat: &crate::protocol::types::ChatRequest) -> bool {
    chat.messages.iter().any(|m| {
        let content = &m.content;
        let arr = match content.as_array() {
            Some(a) => a,
            None => return false,
        };
        arr.iter().any(|b| {
            b.get("type").and_then(|t| t.as_str()).map_or(false, |t| t == "image" || t == "image_url")
                || b.get("image_url").is_some()
        })
    })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test --lib router::role::image_tests -- --nocapture`
Expected: PASS。

- [ ] **Step 5: 请求侧覆盖角色（handlers.rs）**

在 `src-tauri/src/proxy/handlers.rs` 的角色探测处（当前形如 `let role = { ... detect_role(...).or_else(|| Some("auto".to_string())) };`），改为：模型名命中角色 → 若含图则覆盖为 `image` → 否则 `auto`：

```rust
let role = {
    let conn = state.db.conn();
    let conn = conn.lock();
    let detected = crate::router::role::detect_role(&conn, &request_model);
    if crate::router::role::is_image_request(&chat) {
        Some("image".to_string())
    } else {
        detected.or_else(|| Some("auto".to_string()))
    }
};
```

- [ ] **Step 6: 运行 lib 测试确认编译通过**

Run: `cargo test --lib`
Expected: PASS（含新增 image 用例）。

- [ ] **Step 7: 提交（此步先只交后端，前端下一步）**

```bash
git add src-tauri/src/router/role.rs src-tauri/src/proxy/handlers.rs
git commit -m "feat(routing): 请求含图时角色覆盖为 image"
```

---

### Task 2: 前端角色路由页支持 `image` 角色

**Files:**
- Modify: `src/lib/roleSort.ts`
- Modify: `src/pages/RoleRoutesPage.tsx`（`ROLE_COLORS` 增加 `image`）
- Modify (test): `src/lib/__tests__/roleSort.test.ts`（若有）

**Interfaces:**
- Consumes: 既有 `ROLE_ORDER` / `ROLE_COLORS`。
- Produces: `ROLE_ORDER` 含 `"image"`；`ROLE_COLORS` 含 `image`。

- [ ] **Step 1: 更新 `src/lib/roleSort.ts`**

```ts
export const ROLE_ORDER = ["sonnet", "opus", "fable", "haiku", "image", "auto"] as const;
export type Role = (typeof ROLE_ORDER)[number];
```

（`roleSort.ts` 现有 `ROLE_ORDER` 为 `["sonnet","opus","fable","haiku","auto"]`，在 `auto` 前插入 `image`。）

- [ ] **Step 2: 更新 `RoleRoutesPage.tsx` 的 `ROLE_COLORS`**

在 `ROLE_COLORS` 中增加 `image: "bg-violet-500"`（或其它与既有区分开的 class）；确认创建/编辑渠道选择处对 `image` 角色可用（角色下拉、渠道选择已按 `ROLE_ORDER` 渲染，通常自动生效）。

- [ ] **Step 3: 运行前端测试 + typecheck**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/lib/roleSort.ts src/pages/RoleRoutesPage.tsx
git commit -m "feat(routing): 角色路由页支持 image 角色"
```

---

### Task 3: 上游“不支持图像”错误 → 重路由到 image 角色

**Files:**
- Modify: `src-tauri/src/proxy/forwarder.rs`（新增 image-unsupported 错误检测 + 重规划）
- Modify: `src-tauri/src/proxy/rectifier/mod.rs`（错误体检测常量/函数，或新建）
- Test: `src-tauri/src/proxy/forwarder.rs` 或新增纯函数单测

**Interfaces:**
- Produces: `fn is_image_unsupported_error(body: &str) -> bool`（大小写不敏感，匹配 `unsupported image`/`does not support images`/`image.*not supported`/`无效.*图像` 等 key 词）。`fn reroute_to_image(role: &Option<String>) -> bool`（当 `role != Some("image")` 返回 true，表示本次可重路由）。
- Consumes: `ForwardError::Upstream { status, body }`。

- [ ] **Step 1: 写纯函数单测**

在 `forwarder.rs` 的 `#[cfg(test)]` 或 `rectifier/mod.rs`：

```rust
#[test]
fn detects_image_unsupported_error() {
    assert!(is_image_unsupported_error("This model does not support images."));
    assert!(is_image_unsupported_error("unsupported image type"));
    assert!(!is_image_unsupported_error("ratelimit exceeded"));
}
```

- [ ] **Step 2: 运行确认失败** → `cargo test --lib <模块> -- --nocapture` FAIL。

- [ ] **Step 3: 实现检测函数**（放 `proxy/rectifier/media.rs` 或 `forwarder.rs`）：

```rust
const IMAGE_UNSUPPORTED_MARKERS: [&str; 5] = [
    "unsupported image", "does not support images", "doesn't support images",
    "image type not supported", "images are not supported",
];
pub fn is_image_unsupported_error(body: &str) -> bool {
    let b = body.to_lowercase();
    IMAGE_UNSUPPORTED_MARKERS.iter().any(|m| b.contains(m))
}
```

- [ ] **Step 4: 在 `forwarder.rs` 错误循环重路由**

当前 `forward`/`forward_stream` 在 `ForwardError::Upstream{status,..}` 且非 failover 4xx 时直接 `return Err(e)`（约 `forwarder.rs:206-210` / `292-294`）。改为：在该分支，若 `is_image_unsupported_error(&body)` 且 `role != Some("image")`，则对本次请求用 `role=Some("image".into())` 重新 `build_candidates` 并重试一次（最多一次；失败则返回原始错误）。

```rust
ForwardError::Upstream { status, body } if !is_failover_status(status)
    && role.as_deref() != Some("image")
    && is_image_unsupported_error(&body) => {
        if let Some(cands) = build_candidates(state, channels, &Some("image".into()), &chat.model) {
            // 用 image 候选重试一次，成功后返回；失败返回原始错误
            ... // 复用 try_channel 调用
        } else {
            return Err(e);
        }
    }
```

（实现时把现有 `try_candidate` 循环封装为可复用的内部 `fn try_candidates(state, chat, role, model)`，令 `forward`/`forward_stream` 均调用；重路由即用新 role 再调一次。）

- [ ] **Step 5: 运行 `cargo test --lib` 确认编译与既有用例通过**。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/proxy/forwarder.rs src-tauri/src/proxy/rectifier/media.rs
git commit -m "feat(routing): 模型返回不支持图像时重路由到 image 角色"
```

---

### Task 4: 保留 Responses/Gemini 入站图像块（可选增强）

**Files:**
- Modify: `src-tauri/src/protocol/responses.rs`、`src-tauri/src/protocol/gemini.rs`
- Test: 对应 `request_to_chat` 单测

**说明：** 当前 Responses/Gemini 的 `request_to_chat` 只提取 `text` 丢弃图像块，故这些入站协议下 `is_image_request` 检测不到图像。若需覆盖，让它们在 `ChatMessage.content` 中保留图像块（透传），并确保 `build_upstream_body`/`adapter` 对 responses/gemini 相应保留。此项影响面较广，按需实施；openai-chat / anthropic-messages 入站已保留，核心能力已具备。

- [ ] **Step 1:** 先跑 `cargo test --lib` 基线。确认 openai-chat / anthropic 入站的图像检测单测已覆盖（Task 1）。
- [ ] **Step 2-5:** 若实施：为 responses/gemini 的 `request_to_chat` 增加图像块保留 + 单测 + 提交。若本轮不做，标记为已知限制。

---

## Self-Review 自查

- **Spec 覆盖**：C 的请求侧检测 + 前端角色 + 错误侧重路由 + 协议保留（可选）四条均列出。
- **占位符**：无 TBD；代码步骤含真实实现。
- **类型一致**：`is_image_request`、`is_image_unsupported_error`、`is_failover_status` 命名贯穿一致；`ChatRequest`/`ChatMessage`/`ForwardError` 复用现有类型。
- **风险**：Task 3 重路由逻辑复杂，实现时聚焦复用现有 `try_candidate` 循环；Task 4 为可选增强，避免范围膨胀。
