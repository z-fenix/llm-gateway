ALTER TABLE request_logs ADD COLUMN risk_level      TEXT NOT NULL DEFAULT 'clean';
ALTER TABLE request_logs ADD COLUMN risk_score      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN risk_summary    TEXT;
ALTER TABLE request_logs ADD COLUMN security_action TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE request_logs ADD COLUMN sanitized       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN blocked_reason  TEXT;
CREATE INDEX IF NOT EXISTS idx_logs_risk_level ON request_logs(risk_level);

CREATE TABLE IF NOT EXISTS request_security_findings (
  id TEXT PRIMARY KEY, log_id TEXT NOT NULL REFERENCES request_logs(id),
  phase TEXT NOT NULL, category TEXT NOT NULL, rule_id TEXT NOT NULL,
  severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  location TEXT, evidence_masked TEXT, evidence_hash TEXT, action TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_log  ON request_security_findings(log_id);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON request_security_findings(rule_id);

CREATE TABLE IF NOT EXISTS security_builtin_rules (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL,
  description TEXT, toggle_key TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_custom_rules (
  id TEXT PRIMARY KEY, rule_type TEXT NOT NULL, category TEXT NOT NULL,
  pattern TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'medium',
  action TEXT NOT NULL DEFAULT 'warn', enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_rules_type     ON security_custom_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_custom_rules_category ON security_custom_rules(category);
CREATE INDEX IF NOT EXISTS idx_custom_rules_enabled  ON security_custom_rules(enabled);
