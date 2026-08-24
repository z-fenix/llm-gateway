-- API 密钥加密存储：新增 key_hash 列用于认证查找与唯一约束（key 列存密文）。
ALTER TABLE api_keys ADD COLUMN key_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
