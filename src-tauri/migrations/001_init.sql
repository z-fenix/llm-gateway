CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_secs INTEGER NOT NULL DEFAULT 60,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 1.0,
  avg_latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_model_maps (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  source_model TEXT NOT NULL,
  target_model TEXT NOT NULL,
  UNIQUE(channel_id, source_model)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  quota_total INTEGER,
  quota_used INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS role_routes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  target_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  role TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  api_key_id TEXT REFERENCES api_keys(id),
  key_name TEXT,
  channel_id TEXT REFERENCES channels(id),
  channel_name TEXT,
  role TEXT,
  request_model TEXT,
  upstream_model TEXT,
  protocol TEXT NOT NULL,
  status_code INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  fallback INTEGER NOT NULL DEFAULT 0,
  tool_calls TEXT,
  request_body TEXT,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_trace ON request_logs(trace_id);
CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs(channel_id);

-- 默认角色识别规则（大小写不敏感在代码层处理）
INSERT INTO role_patterns (id, pattern, role, priority, enabled) VALUES
  ('pat-sonnet', '*sonnet*', 'sonnet', 100, 1),
  ('pat-opus',   '*opus*',   'opus',   100, 1),
  ('pat-haiku',  '*haiku*', 'haiku',  100, 1),
  ('pat-fable',  '*fable*',  'fable',  100, 1);
