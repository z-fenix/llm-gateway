use super::models::{ApiKey, Channel};
use super::Db;
use crate::error::AppResult;
use rusqlite::params;

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
