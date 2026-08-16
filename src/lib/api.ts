import { invoke } from "@tauri-apps/api/core";
import type {
  ApiKey,
  AppConfigInfo,
  BuiltinRule,
  Channel,
  CliTargetInfo,
  CliWriteResult,
  CustomRule,
  ImportPreview,
  ImportResult,
  KbDocument,
  KnowledgeBase,
  LogFilter,
  LogPage,
  LogStats,
  RagSettings,
  RequestLog,
  RetrievedChunk,
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
  createApiKey: (name: string, quotaTotal: number | null) =>
    invoke<ApiKey>("create_api_key", { name, quotaTotal }),
  setApiKeyEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_api_key_enabled", { id, enabled }),
  deleteApiKey: (id: string) => invoke<void>("delete_api_key", { id }),
  updateQuota: (id: string, quotaTotal: number | null) =>
    invoke<void>("update_quota", { id, quotaTotal }),

  listRoleRoutes: () => invoke<RoleRoute[]>("list_role_routes"),
  setRoleRoute: (role: string, channelId: string, targetModel: string) =>
    invoke<void>("set_role_route", { role, channelId, targetModel }),
  deleteRoleRoute: (role: string) => invoke<void>("delete_role_route", { role }),
  listRolePatterns: () => invoke<RolePattern[]>("list_role_patterns"),
  upsertRolePattern: (p: RolePattern) =>
    invoke<void>("upsert_role_pattern", { p }),
  deleteRolePattern: (id: string) => invoke<void>("delete_role_pattern", { id }),
  getFallback: () => invoke<[string, string] | null>("get_fallback"),
  setFallback: (channelId: string, model: string) =>
    invoke<void>("set_fallback", { channelId, model }),
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
    ruleType: string,
    category: string,
    pattern: string,
    severity: string,
    action: string,
    description: string | null
  ) =>
    invoke<void>("create_custom_security_rule", {
      ruleType,
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
  getSecurityFindings: (logId: string) =>
    invoke<SecurityFinding[]>("get_security_findings", { logId }),

  createKb: (
    name: string,
    description: string | null,
    embeddingChannelId: string | null,
    embeddingModel: string
  ) =>
    invoke<KnowledgeBase>("create_kb", {
      name,
      description,
      embeddingChannelId,
      embeddingModel,
    }),
  listKbs: () => invoke<KnowledgeBase[]>("list_kbs"),
  deleteKb: (id: string) => invoke<void>("delete_kb", { id }),
  reindexKb: (id: string) => invoke<void>("reindex_kb", { id }),
  uploadDocument: (kbId: string, filename: string, contentBase64: string) =>
    invoke<KbDocument>("upload_document", { kbId, filename, contentBase64 }),
  listDocuments: (kbId: string) =>
    invoke<KbDocument[]>("list_documents", { kbId }),
  deleteDocument: (id: string) => invoke<void>("delete_document", { id }),
  searchKb: (kbId: string, query: string) =>
    invoke<RetrievedChunk[]>("search_kb", { kbId, query }),
  getRagSettings: () => invoke<RagSettings>("get_rag_settings"),
  setRagSetting: (key: string, value: unknown) =>
    invoke<void>("set_rag_setting", { key, value }),

  getAppConfig: () => invoke<AppConfigInfo>("get_app_config"),
  setPreferredPort: (port: number) =>
    invoke<void>("set_preferred_port", { port }),
  getCliTargets: () => invoke<CliTargetInfo[]>("get_cli_targets"),
  writeCliConfig: (target: string, apiKeyId: string, writeEnv: boolean) =>
    invoke<CliWriteResult[]>("write_cli_config", { target, apiKeyId, writeEnv }),
  exportConfig: (path: string) => invoke<number>("export_config", { path }),
  defaultExportPath: () => invoke<string>("default_export_path"),
  previewImport: (path: string) => invoke<ImportPreview>("preview_import", { path }),
  importConfig: (path: string, strategy: string) =>
    invoke<ImportResult>("import_config", { path, strategy }),
};
export type { RequestLog };
