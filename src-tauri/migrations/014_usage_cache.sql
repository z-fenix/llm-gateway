-- 使用统计扩展：缓存 token 捕获 + 模型定价 + 写时成本核算
-- cache_read_tokens/cache_creation_tokens：来自上游 usage 的缓存命中/写入 token
-- 四项 *_cost_usd + total_cost_usd：insert_log 写时按 model_pricing 核算；定价变更时 backfill 重算
-- pricing_model：写入时实际用于计价的归一化模型名（normalize(upstream_model)）
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN input_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN output_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_read_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_creation_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN pricing_model TEXT;
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  input_cost_per_million REAL NOT NULL DEFAULT 0, output_cost_per_million REAL NOT NULL DEFAULT 0,
  cache_read_cost_per_million REAL NOT NULL DEFAULT 0, cache_creation_cost_per_million REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
