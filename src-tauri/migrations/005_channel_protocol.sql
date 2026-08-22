-- 将 provider_type 重命名为 supplier，并新增上游协议字段
ALTER TABLE channels RENAME COLUMN provider_type TO supplier;
ALTER TABLE channels ADD COLUMN upstream_protocol TEXT NOT NULL DEFAULT 'openai-chat';

-- 根据原有 supplier 值做一次合理的 upstream_protocol 初始映射
UPDATE channels SET upstream_protocol = 'anthropic-messages' WHERE supplier IN ('claude', 'anthropic');
UPDATE channels SET upstream_protocol = 'gemini-native' WHERE supplier = 'gemini';
