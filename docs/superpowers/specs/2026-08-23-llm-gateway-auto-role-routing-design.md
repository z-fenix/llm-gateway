# Auto 角色路由补全 设计

> 日期: 2026-08-23  
> 前置: 阶段「功能补全 + UI cc-switch 化改造」已合并（commit 6473b87）。  
> 需求来源: init 规格「未匹配角色时使用 Auto 占位」；本阶段将其落为「可配置路由」。

## 1. 目标与非目标

**目标**
1. 未匹配任何角色模式的请求，统一视为角色 `"auto"`（占位）。
2. `role="auto"` 的 `role_routes` 绑定可配置：配置后未匹配请求走该渠道+模型（失败再走全局兜底），与命名角色一致。
3. 未配置 auto 绑定时，未匹配请求保持现有普通调度（priority + weight + model maps），行为不变。
4. UI：角色→渠道路由表增加 Auto 行；日志角色筛选增加 auto 选项；日志中未匹配请求 `role` 显示 `"auto"` 而非 NULL。

**非目标**
- 不改表结构 / 不加迁移（`role_routes.role` 已是自由字符串，`"auto"` 直接可用）。
- 不新增上游协议 / 不改转发器内部逻辑（`forwarder` 已按 `role_route: Option<(channel_id, model)>` 工作）。
- 不改变「命名角色模式优先于 auto」的语义。
- 不做 UI 整体重排（沿用现有 cc-switch 页面）。

## 2. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| Auto 语义 | 可配置路由：`detect_role` 返回 `None` 时视为 `Some("auto")`，查 `role_routes("auto")` |
| 未配置 auto 绑定 | 保持普通调度，不加全局兜底（现状不变） |
| 已配置 auto 绑定 | 走 auto 渠道+模型，失败追加全局兜底（与命名角色一致） |
| 命名角色 vs auto | 命名角色模式优先；仅无任何模式命中时才算 auto |
| 日志 | 未匹配请求 `role = "auto"`（替换原 NULL） |
| 新命令/迁移 | 无 |

## 3. 实现

### 3.1 `src-tauri/src/proxy/handlers.rs`

当前（read 确认）:
```rust
let role = { ... detect_role(&conn, &request_model) };   // Option<String>, None = 未匹配
let role_route = match &role {
    Some(r) => state.repo.get_role_route(r).ok().flatten().map(|rr| (rr.channel_id, rr.target_model)),
    None => None,
};
```

改为: `detect_role` 返回 `None` 时，`role` 落为 `Some("auto".to_string())`（占位）。其余逻辑（`get_role_route("auto")` → 命中则走路由+兜底；未命中 `None` → 普通调度）**无需改动**，因为 `get_role_route` 对任意角色字符串都适用。

具体:
```rust
let role = {
    let conn = state.db.conn();
    let conn = conn.lock();
    crate::router::role::detect_role(&conn, &request_model)
        .or_else(|| Some("auto".to_string()))
};
```
注意: `role` 之后被 `write_log` / `handle_stream` 用于日志字段，未匹配请求会记 `role = "auto"`。

### 3.2 `src/pages/RoleRoutesPage.tsx`

- `ROLES` 常量由 `["sonnet", "opus", "fable", "haiku"]` 增加 `"auto"`（放在末尾）。
- 角色→渠道路由表格多一行 Auto：行首 `auto`，旁边说明「未匹配角色」（如 `<span className="text-xs text-muted-foreground">（未匹配角色）</span>`）。
- 该行绑定/清空复用现有 `bind(role, channel_id, target_model)`（内部调 `setRoleRoute("auto", ...)` / `deleteRoleRoute("auto")`）——无需新命令。
- 角色识别规则说明文案更新：明确 `auto` 是未匹配占位、可绑定渠道/模型。

### 3.3 `src/pages/LogsPage.tsx`

- 角色筛选下拉的 `ROLES` 常量增加 `"auto"`，便于按未匹配请求过滤（对应 `list_logs` 的 `role` 过滤，后端已支持任意 role 字符串）。

### 3.4 文案

- RoleRoutesPage 角色路由 CardDescription 与角色识别规则说明保持与「auto = 未匹配占位」一致。

## 4. 测试计划

- **Rust**（`src-tauri/src/proxy/handlers.rs` 或 `tests/`）:
  - 未匹配请求 + 已配置 `role_routes("auto")` → 命中 auto 渠道，`upstream_model` = auto 目标模型，日志 `role = "auto"`。
  - 未匹配请求 + 未配置 auto → 普通调度（行为不变），日志 `role = "auto"`。
  - 已匹配命名角色（如 `*sonnet*` → sonnet）+ 同时存在 auto 绑定 → 仍走命名角色，auto 不抢占。
  - 现有 `gateway_e2e.rs` 的 `detect_role` 相关单测不受影响（`role.rs` 未改）。
- **前端**（`src/pages/__tests__/RoleRoutesPage.test.tsx`、`LogsPage.test.tsx`）:
  - Auto 行渲染并可绑定/清空（`setRoleRoute` / `deleteRoleRoute` 参数为 `"auto"`）。
  - 日志角色筛选含 auto 选项。
- 运行: `cargo test --lib`、`pnpm typecheck`、`pnpm test:unit` 全绿。

## 5. 风险与回退

| 风险 | 缓解 |
|---|---|
| 日志语义变化（NULL → "auto"）影响既有过滤/统计 | 仅影响「未匹配」这组请求；统计按 role 聚合的视图新增 auto 组，属预期 |
| auto 绑定存在时普通调度被“劫持” | 这正是需求；UI 文案明确 auto 行含义，且可清空绑定恢复普通调度 |
| 误伤命名角色 | 命名角色模式先于 auto 命中，测试覆盖该场景 |

## 6. 交付物

- `handlers.rs` 一行级改动 + `RoleRoutesPage.tsx` / `LogsPage.tsx` UI 改动 + 文案。
- Rust 单测/集成测试 + 前端测试更新。
- 无迁移、无新命令。
