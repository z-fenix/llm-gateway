import { invoke } from "@tauri-apps/api/core";
import type {
  ApiKey,
  BuiltinRule,
  Channel,
  CustomRule,
  LogFilter,
  LogPage,
  LogStats,
  RequestLog,
  RolePattern,
  RoleRoute,
  SecurityFinding,
  SecuritySettings,
  Stats,
  TestResult,
  TimeBucket,
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

  listLogs: (filter: LogFilter) => invoke<LogPage>("list_logs", { filter }),
  getLogStats: (filter: LogFilter) =>
    invoke<LogStats>("get_log_stats", { filter }),
  getLogTimeseries: (filter: LogFilter, bucket: number) =>
    invoke<TimeBucket[]>("get_log_timeseries", { filter, bucket }),
  deleteLogsBefore: (before: number) =>
    invoke<number>("delete_logs_before", { before }),
  clearLogs: () => invoke<number>("clear_logs"),
  getLogRetentionDays: () => invoke<number>("get_log_retention_days"),
  setLogRetentionDays: (days: number) =>
    invoke<void>("set_log_retention_days", { days }),

  getStats: () => invoke<Stats>("get_stats"),

  getSecuritySettings: () => invoke<SecuritySettings>("get_security_settings"),
  setSecuritySetting: (key: string, value: unknown) =>
    invoke<void>("set_security_setting", { key, value }),
  getBuiltinSecurityRules: () =>
    invoke<BuiltinRule[]>("get_builtin_security_rules"),
  updateBuiltinSecurityRule: (
    id: string,
    enabled: boolean,
    severity: string
  ) => invoke<void>("update_builtin_security_rule", { id, enabled, severity }),
  resetBuiltinSecurityRules: () =>
    invoke<void>("reset_builtin_security_rules"),
  getCustomSecurityRules: () => invoke<CustomRule[]>("get_custom_security_rules"),
  createCustomSecurityRule: (
    rule_type: string,
    category: string,
    pattern: string,
    severity: string,
    action: string,
    description: string | null
  ) =>
    invoke<void>("create_custom_security_rule", {
      rule_type,
      category,
      pattern,
      severity,
      action,
      description,
    }),
  toggleCustomSecurityRule: (id: string, enabled: boolean) =>
    invoke<void>("toggle_custom_security_rule", { id, enabled }),
  deleteCustomSecurityRule: (id: string) =>
    invoke<void>("delete_custom_security_rule", { id }),
  getSecurityFindings: (log_id: string) =>
    invoke<SecurityFinding[]>("get_security_findings", { log_id }),
};
export type { RequestLog };
