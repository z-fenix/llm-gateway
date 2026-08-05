export interface Channel {
  id: string;
  name: string;
  provider_type: string;
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
  enabled: boolean;
  updated_at: number;
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
export interface TestResult {
  ok: boolean;
  latency_ms: number;
  error: string | null;
}
