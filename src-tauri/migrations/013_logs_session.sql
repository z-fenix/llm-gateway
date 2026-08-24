-- 请求日志关联本地 CLI session
ALTER TABLE request_logs ADD COLUMN session_id TEXT;
ALTER TABLE request_logs ADD COLUMN session_provider TEXT;
CREATE INDEX IF NOT EXISTS idx_logs_session ON request_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_session_provider ON request_logs(session_provider);
