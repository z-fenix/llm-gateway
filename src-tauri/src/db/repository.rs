use super::models::{ApiKey, Channel, RequestLog, RolePattern, RoleRoute};
use super::Db;
use crate::error::AppResult;
use rusqlite::params;

#[derive(Clone)]
pub struct Repository {
    pub db: Db,
}

impl Repository {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn insert_channel(&self, c: &Channel) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO channels (id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                c.id, c.name, c.provider_type, c.base_url, c.api_key,
                serde_json::to_string(&c.models).unwrap(),
                c.priority, c.weight, c.enabled as i64, c.timeout_secs,
                c.total_calls, c.total_tokens, c.success_rate, c.avg_latency_ms,
                c.created_at, c.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_channel(&self, id: &str) -> AppResult<Option<Channel>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_channel(r)?))
        } else {
            Ok(None)
        }
    }

    pub fn list_channels(&self) -> AppResult<Vec<Channel>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,provider_type,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels ORDER BY priority DESC, created_at ASC",
        )?;
        let rows = stmt.query_map([], row_to_channel)?;
        let mut out = Vec::new();
        for c in rows {
            out.push(c?);
        }
        Ok(out)
    }

    pub fn insert_api_key(&self, k: &ApiKey) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO api_keys (id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                k.id, k.key, k.name, k.enabled as i64, k.quota_total, k.quota_used,
                k.total_calls, k.total_tokens, k.created_at, k.last_used_at
            ],
        )?;
        Ok(())
    }

    pub fn get_api_key_by_key(&self, key: &str) -> AppResult<Option<ApiKey>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at FROM api_keys WHERE key=?1",
        )?;
        let mut rows = stmt.query(params![key])?;
        if let Some(r) = rows.next()? {
            Ok(Some(ApiKey {
                id: r.get(0)?,
                key: r.get(1)?,
                name: r.get(2)?,
                enabled: r.get::<_, i64>(3)? != 0,
                quota_total: r.get(4)?,
                quota_used: r.get(5)?,
                total_calls: r.get(6)?,
                total_tokens: r.get(7)?,
                created_at: r.get(8)?,
                last_used_at: r.get(9)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn consume_quota(&self, key_id: &str, tokens: i64) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "UPDATE api_keys SET quota_used=quota_used+?1, total_tokens=total_tokens+?1,
             total_calls=total_calls+1, last_used_at=?2 WHERE id=?3",
            rusqlite::params![tokens, chrono::Utc::now().timestamp(), key_id],
        )?;
        Ok(())
    }

    pub fn record_channel_stats(&self, channel_id: &str, tokens: i64, latency_ms: i64, success: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        // 简化：累计调用与 token，平均延迟用滑动近似，success_rate 用指数滑动
        conn.execute(
            "UPDATE channels SET total_calls=total_calls+1, total_tokens=total_tokens+?1,
             avg_latency_ms = CASE WHEN total_calls=0 THEN ?2 ELSE (avg_latency_ms*total_calls + ?2)/(total_calls+1) END,
             success_rate = success_rate*0.9 + ?3*0.1
             WHERE id=?4",
            rusqlite::params![tokens, latency_ms, if success {1.0} else {0.0}, channel_id],
        )?;
        Ok(())
    }

    pub fn set_model_map(&self, channel_id: &str, source: &str, target: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO channel_model_maps (id,channel_id,source_model,target_model) VALUES (?1,?2,?3,?4)
             ON CONFLICT(channel_id,source_model) DO UPDATE SET target_model=excluded.target_model",
            params![uuid::Uuid::new_v4().to_string(), channel_id, source, target],
        )?;
        Ok(())
    }

    pub fn get_model_map(&self, channel_id: &str) -> AppResult<Vec<(String, String)>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT source_model, target_model FROM channel_model_maps WHERE channel_id=?1",
        )?;
        let rows = stmt.query_map(params![channel_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn next_log_seq(&self) -> AppResult<i64> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM request_logs", [], |r| r.get(0))?;
        Ok(n)
    }

    pub fn insert_log(&self, l: &RequestLog) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO request_logs (id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
            params![
                l.id, l.seq, l.trace_id, l.api_key_id, l.key_name, l.channel_id, l.channel_name,
                l.role, l.request_model, l.upstream_model, l.protocol, l.status_code,
                l.input_tokens, l.output_tokens, l.latency_ms, l.is_stream as i64, l.error,
                l.fallback as i64, l.tool_calls, l.request_body, l.response_body, l.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_role_route(&self, role: &str) -> AppResult<Option<RoleRoute>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,role,channel_id,target_model,enabled,updated_at FROM role_routes WHERE role=?1 AND enabled=1",
        )?;
        let mut rows = stmt.query(params![role])?;
        if let Some(r) = rows.next()? {
            Ok(Some(RoleRoute {
                id: r.get(0)?, role: r.get(1)?, channel_id: r.get(2)?,
                target_model: r.get(3)?, enabled: r.get::<_, i64>(4)? != 0, updated_at: r.get(5)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_role_patterns(&self) -> AppResult<Vec<RolePattern>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,pattern,role,priority,enabled FROM role_patterns ORDER BY priority DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RolePattern {
                id: r.get(0)?, pattern: r.get(1)?, role: r.get(2)?,
                priority: r.get(3)?, enabled: r.get::<_, i64>(4)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn upsert_role_route(&self, r: &RoleRoute) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        conn.execute(
            "INSERT INTO role_routes (id,role,channel_id,target_model,enabled,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(role) DO UPDATE SET channel_id=excluded.channel_id, target_model=excluded.target_model, enabled=excluded.enabled, updated_at=excluded.updated_at",
            params![r.id, r.role, r.channel_id, r.target_model, r.enabled as i64, r.updated_at],
        )?;
        Ok(())
    }

    pub fn latest_log(&self) -> AppResult<Option<RequestLog>> {
        let conn = self.db.conn();
        let conn = conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,created_at FROM request_logs ORDER BY seq DESC LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(r) = rows.next()? {
            Ok(Some(RequestLog {
                id: r.get(0)?, seq: r.get(1)?, trace_id: r.get(2)?,
                api_key_id: r.get(3)?, key_name: r.get(4)?, channel_id: r.get(5)?,
                channel_name: r.get(6)?, role: r.get(7)?, request_model: r.get(8)?,
                upstream_model: r.get(9)?, protocol: r.get(10)?, status_code: r.get(11)?,
                input_tokens: r.get(12)?, output_tokens: r.get(13)?, latency_ms: r.get(14)?,
                is_stream: r.get::<_, i64>(15)? != 0, error: r.get(16)?,
                fallback: r.get::<_, i64>(17)? != 0, tool_calls: r.get(18)?,
                request_body: r.get(19)?, response_body: r.get(20)?, created_at: r.get(21)?,
            }))
        } else {
            Ok(None)
        }
    }
}

fn row_to_channel(r: &rusqlite::Row) -> rusqlite::Result<Channel> {
    let models_json: String = r.get(5)?;
    Ok(Channel {
        id: r.get(0)?,
        name: r.get(1)?,
        provider_type: r.get(2)?,
        base_url: r.get(3)?,
        api_key: r.get(4)?,
        models: serde_json::from_str(&models_json).unwrap_or_default(),
        priority: r.get(6)?,
        weight: r.get(7)?,
        enabled: r.get::<_, i64>(8)? != 0,
        timeout_secs: r.get(9)?,
        total_calls: r.get(10)?,
        total_tokens: r.get(11)?,
        success_rate: r.get(12)?,
        avg_latency_ms: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str) -> Channel {
        Channel {
            id: id.into(), name: "n".into(), provider_type: "openai".into(),
            base_url: "http://x".into(), api_key: "sk-real".into(),
            models: vec!["gpt-4o".into()], priority: 0, weight: 1, enabled: true,
            timeout_secs: 60, total_calls: 0, total_tokens: 0, success_rate: 1.0,
            avg_latency_ms: 0, created_at: 1, updated_at: 1,
        }
    }

    #[test]
    fn channel_roundtrip() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("c1")).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.api_key, "sk-real");
        assert_eq!(got.models, vec!["gpt-4o".to_string()]);
        assert!(got.enabled);
    }

    #[test]
    fn apikey_lookup_by_key() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-abc".into(), name: "alice".into(),
            enabled: true, quota_total: Some(1000), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        let got = repo.get_api_key_by_key("sk-lgw-abc").unwrap().unwrap();
        assert_eq!(got.name, "alice");
        assert_eq!(got.quota_total, Some(1000));
        assert!(repo.get_api_key_by_key("nope").unwrap().is_none());
    }

    #[test]
    fn default_role_patterns_seeded() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let conn = repo.db.conn();
        let conn = conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM role_patterns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 4);
    }
}
