# Auto 角色路由补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 未匹配任何角色模式的请求统一视为角色 `"auto"`，可像命名角色一样绑定渠道/模型路由；未配置时保持普通调度。

**Architecture:** 在 `handlers.rs` 的角色检测处，`detect_role` 返回 `None` 时落为 `Some("auto")`，复用现有 `role_routes` 机制（`get_role_route("auto")` 命中则走路由+兜底，未命中则普通调度）；前端角色路由表加 Auto 行、日志筛选加 auto 选项。

**Tech Stack:** Rust (axum proxy), React 18 + TypeScript + Tailwind (Tauri 前端), Vitest。

**Spec:** `docs/superpowers/specs/2026-08-23-llm-gateway-auto-role-routing-design.md`

## Global Constraints

- 不改表结构 / 不加迁移（`role_routes.role` 已是自由字符串）。
- 不新增上游协议 / 不改 `forwarder.rs` 转发器内部逻辑。
- 命名角色模式优先于 auto；仅无任何模式命中时才算 auto。
- 未配置 auto 绑定时保持普通调度、不加全局兜底（现状不变）；已配置则走 auto 渠道+模型，失败追加全局兜底。
- 未匹配请求日志 `role = "auto"`（替换原 NULL）。
- `cargo test --lib`、`pnpm typecheck`、`pnpm test:unit` 全绿。
- 前端 UI 文本用中文。

---

### Task 1: 后端 — 未匹配请求视为 auto 角色

**Files:**
- Modify: `src-tauri/src/proxy/handlers.rs`（角色检测块，约 310-315 行）
- Modify: `src-tauri/tests/gateway_e2e.rs`（新增集成测试，或就近的 e2e 文件）
- Test: `cargo test --lib` + `cargo test --test gateway_e2e`（若 e2e 受本机代理影响则在 `--lib` 加单测）

**Interfaces:**
- Consumes: `crate::router::role::detect_role(&conn, &request_model) -> Option<String>`（已有）
- Produces: `role: Option<String>` 在未匹配时为 `Some("auto")`；`role_route` 语义不变（命中 `role_routes("auto")` 则 `Some((channel_id, target_model))`，否则 `None` → 普通调度）。

- [ ] **Step 1: 修改角色检测块**

在 `src-tauri/src/proxy/handlers.rs` 中，把当前：

```rust
    // 4. role detection
    let role = {
        let conn = state.db.conn();
        let conn = conn.lock();
        crate::router::role::detect_role(&conn, &request_model)
    };
```

改为：

```rust
    // 4. role detection —— 未匹配任何角色模式时视为 "auto"（占位角色）
    let role = {
        let conn = state.db.conn();
        let conn = conn.lock();
        crate::router::role::detect_role(&conn, &request_model)
            .or_else(|| Some("auto".to_string()))
    };
```

其余代码（`role_route` match、`write_log`、`handle_stream`）**不动**——`role` 已是 `Option<String>`，`Some("auto")` 会自然传入 `get_role_route("auto")` 与日志字段。

- [ ] **Step 2: 编写 Rust 测试**

在 `src-tauri/src/proxy/handlers.rs` 中新增 `#[cfg(test)] mod tests`（若文件无测试模块则新建；若已有则追加）。用内存 Db + `AppState::new` 直接测角色解析辅助逻辑不可行（`role` 块内联在 `handle()`），因此改为**测行为**：起网关、发未匹配请求、断言日志 `role = "auto"`。

在 `src-tauri/tests/gateway_e2e.rs` 追加集成测试（仿照现有 `end_to_end_openai_with_role_route_and_logging` 的模式：`spawn_mock` → 插渠道/密钥 → `server::start(state, 0)` → POST → 查 `repo.latest_log()`）：

```rust
#[tokio::test]
async fn unmatched_role_requests_logged_as_auto() {
    let (base, _mock) = common::spawn_mock(200, serde_json::json!({
        "id":"c1","object":"chat.completion","model":"m",
        "choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}
    })).await;

    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1", &base)).unwrap();
    repo.insert_api_key(&ApiKey {
        id: "k1".into(), key: "sk-lgw-auto".into(), name: "t".into(), enabled: true,
        quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
        created_at: 1, last_used_at: None,
    }).unwrap();

    let state = AppState::new(db);
    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();

    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-auto")
        .json(&serde_json::json!({
            "model":"gpt-4o",   // 不匹配任何角色模式
            "messages":[{"role":"user","content":"hi"}]
        }))
        .send().await.unwrap();
    assert_eq!(resp.status(), 200);

    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.role.as_deref(), Some("auto"));
    assert_eq!(log.request_model.as_deref(), Some("gpt-4o"));
    // 未配置 auto 路由 → 走普通调度渠道 c1（唯一启用渠道）
    assert_eq!(log.channel_id.as_deref(), Some("c1"));
}
```

再补一个「已配置 auto 路由 → 走 auto 渠道」测试：先 `repo.upsert_role_route(&RoleRoute { id: "r-auto".into(), role: "auto".into(), channel_id: "c1".into(), target_model: "deepseek-v4-flash".into(), enabled: true, updated_at: 1 })`，发送 `model: "gpt-4o"`，断言 `log.role == Some("auto")` 且 `log.upstream_model == Some("deepseek-v4-flash")`。

- [ ] **Step 3: 运行测试**

从 `src-tauri/`：
```bash
cargo test --test gateway_e2e -- --nocapture
cargo test --lib 2>&1 | tail -3
```
预期：新测试通过（若 `gateway_e2e` 因本机系统代理 503 失败——这是已知环境问题、非本改动引入——则以 `cargo test --lib` 为准，并在报告中注明 e2e 受代理影响）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/proxy/handlers.rs src-tauri/tests/gateway_e2e.rs
git commit -m "feat(auto): 未匹配角色请求视为 auto 占位角色"
```

---

### Task 2: 前端 — 角色路由表 Auto 行 + 日志筛选 auto 选项

**Files:**
- Modify: `src/pages/RoleRoutesPage.tsx`（`ROLES` 常量 + 路由表 + 文案）
- Modify: `src/pages/LogsPage.tsx`（角色筛选 `ROLES` 常量）
- Modify: `src/pages/__tests__/RoleRoutesPage.test.tsx`（Auto 行测试）
- Modify: `src/pages/__tests__/LogsPage.test.tsx`（auto 筛选选项测试）
- Test: `pnpm typecheck` + `pnpm test:unit`

**Interfaces:**
- Consumes: `api.setRoleRoute(role, channelId, targetModel)` / `api.deleteRoleRoute(role)`（已有，任意角色字符串）；`src/pages/RoleRoutesPage.tsx` 内 `bind(role, channelId, targetModel)`、`routeFor(role)` 已有。
- Produces: 路由表渲染 `auto` 行并复用 `bind`/`routeFor`；日志筛选含 `"auto"` 选项。

- [ ] **Step 1: RoleRoutesPage 增加 Auto 行**

在 `src/pages/RoleRoutesPage.tsx` 中：

1. 把常量改为：
```ts
const ROLES = ["sonnet", "opus", "fable", "haiku", "auto"];
```
2. 更新注释：
```ts
// "auto" 是未匹配任何角色模式时的占位角色：可绑定渠道/模型；未绑定则走普通调度。
```
3. 在路由表 `ROLES.map((role) => (...))` 的 role 单元格内，对 `role === "auto"` 追加说明：
```tsx
<td className="p-4 font-medium">
  {role}
  {role === "auto" && (
    <span className="ml-1 text-xs text-muted-foreground">（未匹配角色）</span>
  )}
</td>
```
（先读该 map 当前渲染以精确定位单元格；`routeFor(role)` 与 `bind(role, ...)` 对 `"auto"` 无需改动即生效。）

4. 更新「角色识别规则」CardDescription（约 335 行）与「角色路由」CardDescription，文案明确：`auto` 是未匹配占位，可像命名角色一样绑定渠道/模型，未绑定则走普通调度。

- [ ] **Step 2: LogsPage 角色筛选加 auto**

在 `src/pages/LogsPage.tsx` 中把：
```ts
const ROLES = ["sonnet", "opus", "fable", "haiku"];
```
改为：
```ts
const ROLES = ["sonnet", "opus", "fable", "haiku", "auto"];
```

- [ ] **Step 3: 前端测试**

在 `src/pages/__tests__/RoleRoutesPage.test.tsx` 追加：

```tsx
it("渲染 Auto 行并可绑定渠道", async () => {
  // 现有 mock: api.listRoleRoutes 返回 []，setRoleRoute/deleteRoleRoute 为 vi.fn()
  render(<RoleRoutesPage />);
  const autoRow = await screen.findByText("auto");
  expect(autoRow).toBeInTheDocument();
  // 复用同文件既有测试「切换角色渠道调用 setRoleRoute/deleteRoleRoute」(约 78-100 行)的
  // radix Select 交互模式: fireEvent.click(getByRole("combobox", ...)) → findByRole("option") → click
  // 选中 auto 行的渠道 select(用 aria-label 或行内定位)后,断言:
  expect(api.setRoleRoute).toHaveBeenCalledWith(
    "auto",
    expect.any(String),
    expect.any(String)
  );
});
```

在 `src/pages/__tests__/LogsPage.test.tsx` 追加：断言角色筛选下拉包含 `auto` 选项（先读该文件现有 select 测试模式复用）。

- [ ] **Step 4: 运行验证**

从仓库根：
```bash
pnpm typecheck
pnpm test:unit
```
预期：typecheck exit 0，全部测试通过（现有 + 新增）。

- [ ] **Step 5: Commit**

```bash
git add src/pages/RoleRoutesPage.tsx src/pages/LogsPage.tsx src/pages/__tests__/RoleRoutesPage.test.tsx src/pages/__tests__/LogsPage.test.tsx
git commit -m "feat(auto): 角色路由表 Auto 行 + 日志筛选 auto 选项"
```

---

## 验收

- `cargo test --lib` 全绿（280+ 现有 + 新增通过）。
- `pnpm typecheck` + `pnpm test:unit` 全绿。
- `pnpm dev` 手动验证（可选）：未匹配请求在日志中 `role = auto`；RoleRoutes 页可把 Auto 绑定到某渠道/模型后，未匹配请求走该渠道。
