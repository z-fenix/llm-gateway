import { invoke } from "@tauri-apps/api/core";
import type {
  ApiKey,
  Channel,
  LogPage,
  RequestLog,
  RolePattern,
  RoleRoute,
  Stats,
  TestResult,
} from "../types";

export const api = {
  listChannels: () => invoke<Channel[]>("list_channels"),
  createChannel: (c: Channel) => invoke<Channel>("create_channel", { c }),
  updateChannel: (c: Channel) => invoke<void>("update_channel", { c }),
  deleteChannel: (id: string) => invoke<void>("delete_channel", { id }),
  testChannel: (id: string) => invoke<TestResult>("test_channel", { id }),

  listApiKeys: () => invoke<ApiKey[]>("list_api_keys"),
  createApiKey: (name: string, quota_total: number | null) =>
    invoke<ApiKey>("create_api_key", { name, quota_total }),
  setApiKeyEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_api_key_enabled", { id, enabled }),
  deleteApiKey: (id: string) => invoke<void>("delete_api_key", { id }),
  updateQuota: (id: string, quota_total: number | null) =>
    invoke<void>("update_quota", { id, quota_total }),

  listRoleRoutes: () => invoke<RoleRoute[]>("list_role_routes"),
  setRoleRoute: (role: string, channel_id: string, target_model: string) =>
    invoke<void>("set_role_route", { role, channel_id, target_model }),
  deleteRoleRoute: (role: string) => invoke<void>("delete_role_route", { role }),
  listRolePatterns: () => invoke<RolePattern[]>("list_role_patterns"),
  upsertRolePattern: (p: RolePattern) =>
    invoke<void>("upsert_role_pattern", { p }),
  deleteRolePattern: (id: string) => invoke<void>("delete_role_pattern", { id }),
  getFallback: () => invoke<[string, string] | null>("get_fallback"),
  setFallback: (channel_id: string, model: string) =>
    invoke<void>("set_fallback", { channel_id, model }),
  clearFallback: () => invoke<void>("clear_fallback"),

  listLogs: (keyword: string | null, limit: number, offset: number) =>
    invoke<LogPage>("list_logs", { filter: { keyword, limit, offset } }),
  getStats: () => invoke<Stats>("get_stats"),
};
export type { RequestLog };
