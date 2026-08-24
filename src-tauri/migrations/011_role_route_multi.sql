-- 角色路由支持同一角色多个供应商/模型：去掉 role UNIQUE，
-- 新增 priority(同组加权随机的组序)/weight(同优先级组内权重)与熔断配置。
CREATE TABLE role_routes_new (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  target_model TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  breaker_max_failures INTEGER NOT NULL DEFAULT 5,
  breaker_cooldown_secs INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

INSERT INTO role_routes_new (id, role, channel_id, target_model, priority, weight, breaker_max_failures, breaker_cooldown_secs, enabled, updated_at)
  SELECT id, role, channel_id, target_model, 0, 1, 5, 60, enabled, updated_at FROM role_routes;

DROP TABLE role_routes;
ALTER TABLE role_routes_new RENAME TO role_routes;

CREATE INDEX idx_role_routes_role ON role_routes(role);
