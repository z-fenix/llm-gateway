import type { RoleRoute } from "../types";

// 角色卡片固定顺序（与路由调度语义一致）
export const ROLE_ORDER = ["sonnet", "opus", "fable", "haiku", "auto"];

// 角色详情面板排序：与调度一致 —— priority 降序 → weight 降序
export function sortRoutesForRole(routes: RoleRoute[]): RoleRoute[] {
  return [...routes].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return 0;
  });
}

// 取某角色的全部路由并按 priority 降序 → weight 降序返回
export function routesByRole(routes: RoleRoute[], role: string): RoleRoute[] {
  return sortRoutesForRole(routes.filter((r) => r.role === role));
}
