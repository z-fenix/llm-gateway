CREATE INDEX IF NOT EXISTS idx_logs_status   ON request_logs(status_code);
CREATE INDEX IF NOT EXISTS idx_logs_api_key  ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_logs_channel  ON request_logs(channel_id);
