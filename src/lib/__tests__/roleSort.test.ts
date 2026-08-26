import { describe, it, expect } from "vitest";
import { ROLE_ORDER, routesByRole, sortRoutesForRole } from "../roleSort";
import type { RoleRoute } from "../../types";

function route(id: string, role: string, priority: number, weight: number): RoleRoute {
  return {
    id,
    role,
    channel_id: "c1",
    target_model: "m1",
    priority,
    weight,
    breaker_max_failures: 5,
    breaker_cooldown_secs: 60,
    enabled: true,
    updated_at: 0,
  };
}

describe("roleSort", () => {
  it("ROLE_ORDER 固定顺序 sonnet/opus/fable/haiku/image/auto", () => {
    expect(ROLE_ORDER).toEqual(["sonnet", "opus", "fable", "haiku", "image", "auto"]);
  });

  it("按 priority 降序 → weight 降序", () => {
    const routes = [
      route("a", "sonnet", 0, 5),
      route("b", "sonnet", 10, 1),
      route("c", "sonnet", 10, 9),
      route("d", "sonnet", 5, 2),
    ];
    const sorted = sortRoutesForRole(routes);
    expect(sorted.map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("routesByRole 只返回该角色且保持排序", () => {
    const routes = [
      route("a", "sonnet", 0, 1),
      route("b", "opus", 99, 1),
      route("c", "sonnet", 5, 1),
    ];
    const got = routesByRole(routes, "sonnet");
    expect(got.map((r) => r.id)).toEqual(["c", "a"]);
  });

  it("sortRoutesForRole 不修改原数组", () => {
    const routes = [route("a", "sonnet", 5, 1), route("b", "sonnet", 10, 1)];
    const before = [...routes];
    sortRoutesForRole(routes);
    expect(routes).toEqual(before);
  });
});
