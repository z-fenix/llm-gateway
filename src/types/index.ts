export interface Channel {
  id: string;
  name: string;
  supplier: string;
  upstream_protocol: string;
  base_url: string;
  api_key: string;
  models: string[];
  priority: number;
  weight: number;
  enabled: boolean;
  timeout_secs: number;
  total_calls: number;
  total_tokens: number;
  success_rate: number;
  avg_latency_ms: number;
  created_at: number;
  updated_at: number;
}
export interface ApiKey {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  quota_total: number | null;
  quota_used: number;
  total_calls: number;
  total_tokens: number;
  created_at: number;
  last_used_at: number | null;
}
export interface RoleRoute {
  id: string;
  role: string;
  channel_id: string;
  target_model: string;
  priority: number;
  weight: number;
  breaker_max_failures: number;
  breaker_cooldown_secs: number;
  enabled: boolean;
  updated_at: number;
}
export interface BreakerStatus {
  route_id: string;
  state: "closed" | "open" | "half_open";
  failures: number;
}
export interface ModelMapEntry {
  channel_id: string;
  source_model: string;
  target_model: string;
}
export interface RolePattern {
  id: string;
  pattern: string;
  role: string;
  priority: number;
  enabled: boolean;
}
export interface RequestLog {
  id: string;
  seq: number;
  trace_id: string;
  api_key_id: string | null;
  key_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  role: string | null;
  request_model: string | null;
  upstream_model: string | null;
  protocol: string;
  status_code: number | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  is_stream: boolean;
  error: string | null;
  fallback: boolean;
  tool_calls: string | null;
  request_body: string | null;
  response_body: string | null;
  risk_level: string;
  risk_score: number;
  risk_summary: string | null;
  security_action: string;
  sanitized: boolean;
  blocked_reason: string | null;
  created_at: number;
}
export interface Stats {
  today_requests: number;
  today_tokens: number;
  total_requests: number;
  total_tokens: number;
  active_channels: number;
  avg_latency_ms: number;
}
export interface LogPage {
  items: RequestLog[];
  total: number;
}
export type StatusClass = "2xx" | "4xx" | "5xx";
export interface LogFilter {
  keyword?: string;
  api_key_id?: string;
  channel_id?: string;
  role?: string;
  risk_level?: string;
  status?: StatusClass;
  is_stream?: boolean;
  after?: number;
  before?: number;
  limit?: number;
  offset?: number;
}
export interface LogStats {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  success_count: number;
  risk_distribution: [string, number][];
  top_channels: [string, number][];
  top_api_keys: [string, number][];
}
export interface TimeBucket {
  bucket: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  error_count: number;
  risk_counts: Record<string, number>;
}
export interface TestResult {
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

export interface SecuritySettings {
  enabled: boolean;
  mode: string;
  scan_request: boolean;
  scan_response: boolean;
  scan_unicode: boolean;
  scan_tools: boolean;
  scan_network: boolean;
  redact_secrets: boolean;
  block_on_critical: boolean;
  max_scan_bytes: number;
}

export interface BuiltinRule {
  id: string;
  rule_id: string;
  category: string;
  severity: string;
  title: string;
  description: string | null;
  toggle_key: string | null;
  enabled: boolean;
  created_at: number;
}

export interface CustomRule {
  id: string;
  rule_type: string;
  category: string;
  pattern: string;
  severity: string;
  action: string;
  enabled: boolean;
  description: string | null;
  created_at: number;
}

export interface SecurityFinding {
  id: string;
  log_id: string;
  phase: string;
  category: string;
  rule_id: string;
  severity: string;
  title: string;
  description: string | null;
  location: string | null;
  evidence_masked: string | null;
  evidence_hash: string | null;
  action: string | null;
  created_at: number;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  embedding_channel_id: string | null;
  embedding_model: string;
  dim: number;
  doc_count: number;
  chunk_count: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  needs_reindex: boolean;
}

export interface KbDocument {
  id: string;
  kb_id: string;
  filename: string;
  file_type: string;
  size_bytes: number;
  chunk_count: number;
  status: string;
  error: string | null;
  created_at: number;
}

export interface RetrievedChunk {
  embedding_id: number;
  content: string;
  symbol: string | null;
  filename: string;
  score: number;
}

export interface RagSettings {
  enabled: boolean;
  default_kb: string | null;
  default_embedding_channel: string | null;
}

export interface RectifierConfig {
  enabled: boolean;
  request_thinking_signature: boolean;
  request_thinking_budget: boolean;
  request_media_fallback: boolean;
  request_media_heuristic: boolean;
}

export interface AppConfigInfo {
  preferred_port: number;
  bound_addr: string | null;
}

export interface CliTargetInfo {
  target: string;
  configured: boolean;
  path: string;
}

export interface CliWriteResult {
  path: string;
  changed_keys: string[];
  backup_path: string | null;
  env_instructions: string | null;
}

export interface ImportPreview {
  channels: number;
  api_keys: number;
  role_routes: number;
  role_patterns: number;
  custom_rules: number;
  conflicts: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  description: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface SessionMeta {
  providerId: string;
  sessionId: string;
  title?: string | null;
  summary?: string | null;
  projectDir?: string | null;
  createdAt?: number | null;
  lastActiveAt?: number | null;
  sourcePath?: string | null;
  resumeCommand?: string | null;
}

export interface SessionMessage {
  role: string;
  content: string;
  ts?: number | null;
}

export interface McpServer {
  id: string;
  name: string;
  server_config: any;
  description: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface McpServerView {
  server: McpServer;
  connected: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  directory: string;
  content: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface SkillView {
  skill: Skill;
  synced: boolean;
}

export interface McpDecl {
  name: string;
  config: any;
}

export interface InstalledSkill {
  directory: string;
  name: string | null;
  description: string | null;
  version: string | null;
  mcp_servers: McpDecl[];
  in_db: boolean;
  enabled: boolean;
  synced: boolean;
}

export type UsageRangePreset = "today" | "1d" | "7d" | "14d" | "30d" | "custom";

export interface UsageRangeSelection {
  preset: UsageRangePreset;
  customStartDate?: number;
  customEndDate?: number;
  liveEndTime?: boolean;
}
