use super::models::{ApiKey, BuiltinRule, Channel, CustomRule, KbChunk, KbDocument, KnowledgeBase, RequestLog, RequestSecurityFinding, RolePattern, RoleRoute};
use super::Db;
use crate::error::AppResult;
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct Repository {
    pub db: Db,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StatusClass {
    Success,
    ClientError,
    ServerError,
}

impl StatusClass {
    pub fn range(&self) -> (i64, i64) {
        match self {
            StatusClass::Success => (200, 299),
            StatusClass::ClientError => (400, 499),
            StatusClass::ServerError => (500, 599),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LogFilter {
    pub keyword: Option<String>,
    pub api_key_id: Option<String>,
    pub channel_id: Option<String>,
    pub role: Option<String>,
    pub risk_level: Option<String>,
    pub status: Option<StatusClass>,
    pub is_stream: Option<bool>,
    pub after: Option<i64>,
    pub before: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LogStats {
    pub total_calls: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub success_count: i64,
    pub risk_distribution: Vec<(String, i64)>,
    pub top_channels: Vec<(String, i64)>,
    pub top_api_keys: Vec<(String, i64)>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct TimeBucket {
    pub bucket: i64,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub error_count: i64,
    pub risk_counts: BTreeMap<String, i64>,
}

fn build_where(filter: &LogFilter) -> (String, Vec<rusqlite::types::Value>) {
    let mut sql = String::from("WHERE 1=1");
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    if let Some(kw) = &filter.keyword {
        sql.push_str(" AND (request_model LIKE ? OR upstream_model LIKE ? OR trace_id LIKE ? OR channel_name LIKE ? OR key_name LIKE ?)");
        let like = format!("%{}%", kw);
        values.push(like.clone().into());
        values.push(like.clone().into());
        values.push(like.clone().into());
        values.push(like.clone().into());
        values.push(like.into());
    }
    if let Some(v) = &filter.api_key_id {
        sql.push_str(" AND api_key_id = ?");
        values.push(v.clone().into());
    }
    if let Some(v) = &filter.channel_id {
        sql.push_str(" AND channel_id = ?");
        values.push(v.clone().into());
    }
    if let Some(v) = &filter.role {
        sql.push_str(" AND role = ?");
        values.push(v.clone().into());
    }
    if let Some(v) = &filter.risk_level {
        sql.push_str(" AND risk_level = ?");
        values.push(v.clone().into());
    }
    if let Some(s) = &filter.status {
        sql.push_str(" AND status_code BETWEEN ? AND ?");
        let (lo, hi) = s.range();
        values.push(lo.into());
        values.push(hi.into());
    }
    if let Some(v) = filter.is_stream {
        sql.push_str(" AND is_stream = ?");
        values.push((if v { 1i64 } else { 0i64 }).into());
    }
    if let Some(v) = filter.after {
        sql.push_str(" AND created_at >= ?");
        values.push(v.into());
    }
    if let Some(v) = filter.before {
        sql.push_str(" AND created_at <= ?");
        values.push(v.into());
    }

    (sql, values)
}

impl Repository {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn insert_channel(&self, c: &Channel) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO channels (id,name,supplier,upstream_protocol,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                c.id, c.name, c.supplier, c.upstream_protocol, c.base_url, c.api_key,
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
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,name,supplier,upstream_protocol,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels WHERE id=?1",
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
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,name,supplier,upstream_protocol,base_url,api_key,models,priority,weight,enabled,timeout_secs,total_calls,total_tokens,success_rate,avg_latency_ms,created_at,updated_at FROM channels ORDER BY priority DESC, created_at ASC",
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
        let conn = conn.lock();
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

    pub fn update_api_key(&self, k: &ApiKey) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE api_keys SET key=?2,name=?3,enabled=?4,quota_total=?5,quota_used=?6,total_calls=?7,total_tokens=?8,created_at=?9,last_used_at=?10 WHERE id=?1",
            params![
                k.id, k.key, k.name, k.enabled as i64, k.quota_total, k.quota_used,
                k.total_calls, k.total_tokens, k.created_at, k.last_used_at
            ],
        )?;
        Ok(())
    }

    pub fn get_api_key_by_key(&self, key: &str) -> AppResult<Option<ApiKey>> {
        let conn = self.db.conn();
        let conn = conn.lock();
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

    pub fn consume_quota(&self, key_id: &str, tokens: i64) -> AppResult<bool> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let n = conn.execute(
            "UPDATE api_keys SET quota_used=quota_used+?1, total_tokens=total_tokens+?1,
             total_calls=total_calls+1, last_used_at=?2
             WHERE id=?3 AND (quota_total IS NULL OR quota_used+?1<=quota_total)",
            rusqlite::params![tokens, chrono::Utc::now().timestamp(), key_id],
        )?;
        Ok(n > 0)
    }

    pub fn record_channel_stats(&self, channel_id: &str, tokens: i64, latency_ms: i64, success: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
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
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO channel_model_maps (id,channel_id,source_model,target_model) VALUES (?1,?2,?3,?4)
             ON CONFLICT(channel_id,source_model) DO UPDATE SET target_model=excluded.target_model",
            params![uuid::Uuid::new_v4().to_string(), channel_id, source, target],
        )?;
        Ok(())
    }

    pub fn get_model_map(&self, channel_id: &str) -> AppResult<Vec<(String, String)>> {
        let conn = self.db.conn();
        let conn = conn.lock();
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

    pub fn delete_model_map(&self, channel_id: &str, source: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "DELETE FROM channel_model_maps WHERE channel_id=?1 AND source_model=?2",
            params![channel_id, source],
        )?;
        Ok(())
    }

    pub fn insert_log(&self, l: &RequestLog) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let seq: i64 = conn.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM request_logs", [], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO request_logs (id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,risk_level,risk_score,risk_summary,security_action,sanitized,blocked_reason,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)",
            params![
                l.id, seq, l.trace_id, l.api_key_id, l.key_name, l.channel_id, l.channel_name,
                l.role, l.request_model, l.upstream_model, l.protocol, l.status_code,
                l.input_tokens, l.output_tokens, l.latency_ms, l.is_stream as i64, l.error,
                l.fallback as i64, l.tool_calls, l.request_body, l.response_body,
                l.risk_level, l.risk_score, l.risk_summary, l.security_action, l.sanitized as i64,
                l.blocked_reason, l.created_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_logs_before(&self, ts: i64) -> AppResult<usize> {
        let conn = self.db.conn();
        let mut conn = conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM request_security_findings WHERE log_id IN (SELECT id FROM request_logs WHERE created_at < ?1)",
            params![ts],
        )?;
        let deleted = tx.execute("DELETE FROM request_logs WHERE created_at < ?1", params![ts])?;
        tx.commit()?;
        Ok(deleted)
    }

    pub fn clear_logs(&self) -> AppResult<usize> {
        let conn = self.db.conn();
        let mut conn = conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM request_security_findings", [])?;
        let deleted = tx.execute("DELETE FROM request_logs", [])?;
        tx.commit()?;
        Ok(deleted)
    }

    pub fn get_role_route(&self, role: &str) -> AppResult<Option<RoleRoute>> {
        let conn = self.db.conn();
        let conn = conn.lock();
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
        let conn = conn.lock();
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
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO role_routes (id,role,channel_id,target_model,enabled,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(role) DO UPDATE SET channel_id=excluded.channel_id, target_model=excluded.target_model, enabled=excluded.enabled, updated_at=excluded.updated_at",
            params![r.id, r.role, r.channel_id, r.target_model, r.enabled as i64, r.updated_at],
        )?;
        Ok(())
    }

    pub fn latest_log(&self) -> AppResult<Option<RequestLog>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,risk_level,risk_score,risk_summary,security_action,sanitized,blocked_reason,created_at FROM request_logs ORDER BY seq DESC LIMIT 1",
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
                request_body: r.get(19)?, response_body: r.get(20)?,
                risk_level: r.get(21)?, risk_score: r.get(22)?, risk_summary: r.get(23)?,
                security_action: r.get(24)?, sanitized: r.get::<_, i64>(25)? != 0,
                blocked_reason: r.get(26)?, created_at: r.get(27)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn update_channel(&self, c: &Channel) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE channels SET name=?2,supplier=?3,upstream_protocol=?4,base_url=?5,api_key=?6,models=?7,priority=?8,weight=?9,enabled=?10,timeout_secs=?11,updated_at=?12 WHERE id=?1",
            rusqlite::params![c.id,c.name,c.supplier,c.upstream_protocol,c.base_url,c.api_key,serde_json::to_string(&c.models).unwrap(),c.priority,c.weight,c.enabled as i64,c.timeout_secs,c.updated_at],
        )?;
        Ok(())
    }
    pub fn delete_channel(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM channels WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn set_api_key_enabled(&self, id: &str, enabled: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("UPDATE api_keys SET enabled=?2 WHERE id=?1", rusqlite::params![id, enabled as i64])?;
        Ok(())
    }
    pub fn delete_api_key(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM api_keys WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn update_quota(&self, id: &str, quota_total: Option<i64>) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("UPDATE api_keys SET quota_total=?2 WHERE id=?1", rusqlite::params![id, quota_total])?;
        Ok(())
    }
    pub fn list_api_keys(&self) -> AppResult<Vec<ApiKey>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare("SELECT id,key,name,enabled,quota_total,quota_used,total_calls,total_tokens,created_at,last_used_at FROM api_keys ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| Ok(ApiKey {
            id: r.get(0)?, key: r.get(1)?, name: r.get(2)?, enabled: r.get::<_,i64>(3)? != 0,
            quota_total: r.get(4)?, quota_used: r.get(5)?, total_calls: r.get(6)?,
            total_tokens: r.get(7)?, created_at: r.get(8)?, last_used_at: r.get(9)?,
        }))?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }
    pub fn delete_role_route(&self, role: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM role_routes WHERE role=?1", [role])?;
        Ok(())
    }
    pub fn list_role_routes(&self) -> AppResult<Vec<crate::db::models::RoleRoute>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare("SELECT id,role,channel_id,target_model,enabled,updated_at FROM role_routes")?;
        let rows = stmt.query_map([], |r| Ok(crate::db::models::RoleRoute {
            id: r.get(0)?, role: r.get(1)?, channel_id: r.get(2)?, target_model: r.get(3)?,
            enabled: r.get::<_,i64>(4)? != 0, updated_at: r.get(5)?,
        }))?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }
    pub fn upsert_role_pattern(&self, p: &crate::db::models::RolePattern) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO role_patterns (id,pattern,role,priority,enabled) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET pattern=excluded.pattern, role=excluded.role, priority=excluded.priority, enabled=excluded.enabled",
            rusqlite::params![p.id,p.pattern,p.role,p.priority,p.enabled as i64],
        )?;
        Ok(())
    }
    pub fn delete_role_pattern(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM role_patterns WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn count_logs(&self, filter: &LogFilter) -> AppResult<i64> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let (where_sql, values) = build_where(filter);
        let sql = format!("SELECT COUNT(*) FROM request_logs {}", where_sql);
        let n: i64 = conn.query_row(&sql, rusqlite::params_from_iter(values), |r| r.get(0))?;
        Ok(n)
    }
    pub fn log_stats(&self, filter: &LogFilter) -> AppResult<LogStats> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let (where_sql, values) = build_where(filter);

        let agg_sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END),0) FROM request_logs {}",
            where_sql
        );
        let (total_calls, total_input_tokens, total_output_tokens, success_count): (i64, i64, i64, i64) =
            conn.query_row(&agg_sql, rusqlite::params_from_iter(values.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?;

        let risk_sql = format!(
            "SELECT risk_level, COUNT(*) FROM request_logs {} GROUP BY risk_level ORDER BY COUNT(*) DESC, risk_level ASC",
            where_sql
        );
        let mut stmt = conn.prepare(&risk_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut risk_distribution = Vec::new();
        for r in rows {
            risk_distribution.push(r?);
        }

        let channel_sql = format!(
            "SELECT channel_name, COUNT(*) FROM request_logs {} AND channel_name IS NOT NULL GROUP BY channel_name ORDER BY COUNT(*) DESC, channel_name ASC LIMIT 5",
            where_sql
        );
        let mut stmt = conn.prepare(&channel_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut top_channels = Vec::new();
        for r in rows {
            top_channels.push(r?);
        }

        let key_sql = format!(
            "SELECT key_name, COUNT(*) FROM request_logs {} AND key_name IS NOT NULL GROUP BY key_name ORDER BY COUNT(*) DESC, key_name ASC LIMIT 5",
            where_sql
        );
        let mut stmt = conn.prepare(&key_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut top_api_keys = Vec::new();
        for r in rows {
            top_api_keys.push(r?);
        }

        Ok(LogStats {
            total_calls,
            total_input_tokens,
            total_output_tokens,
            success_count,
            risk_distribution,
            top_channels,
            top_api_keys,
        })
    }

    pub fn log_timeseries(
        &self,
        filter: &LogFilter,
        bucket_secs: i64,
    ) -> AppResult<Vec<TimeBucket>> {
        if bucket_secs <= 0 {
            return Ok(Vec::new());
        }

        let conn = self.db.conn();
        let conn = conn.lock();
        let (where_sql, where_values) = build_where(filter);

        let sql = format!(
            "SELECT (created_at / ?) * ? AS bucket, \
             COUNT(*), \
             COALESCE(SUM(input_tokens), 0), \
             COALESCE(SUM(output_tokens), 0), \
             COALESCE(SUM(CASE WHEN status_code NOT BETWEEN 200 AND 299 THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'clean' THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'info' THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'low' THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'medium' THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END), 0), \
             COALESCE(SUM(CASE WHEN risk_level = 'critical' THEN 1 ELSE 0 END), 0) \
             FROM request_logs {} \
             GROUP BY bucket \
             ORDER BY bucket ASC",
            where_sql
        );

        let risk_levels = ["clean", "info", "low", "medium", "high", "critical"];
        let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(2 + where_values.len());
        params.push(bucket_secs.into());
        params.push(bucket_secs.into());
        params.extend(where_values);

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let bucket: i64 = r.get(0)?;
            let calls: i64 = r.get(1)?;
            let input_tokens: i64 = r.get(2)?;
            let output_tokens: i64 = r.get(3)?;
            let error_count: i64 = r.get(4)?;
            let mut risk_counts = BTreeMap::<String, i64>::new();
            for (idx, level) in risk_levels.iter().enumerate() {
                risk_counts.insert(level.to_string(), r.get::<_, i64>(5 + idx)?);
            }
            Ok(TimeBucket {
                bucket,
                calls,
                input_tokens,
                output_tokens,
                error_count,
                risk_counts,
            })
        })?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
    pub fn list_logs(&self, filter: &LogFilter, limit: i64, offset: i64) -> AppResult<Vec<RequestLog>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let (where_sql, values) = build_where(filter);
        let sql = format!(
            "SELECT id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,risk_level,risk_score,risk_summary,security_action,sanitized,blocked_reason,created_at FROM request_logs {} ORDER BY seq DESC LIMIT ? OFFSET ?",
            where_sql
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(values.iter().chain([limit.into(), offset.into()].iter())),
            |r| Ok(RequestLog {
                id: r.get(0)?, seq: r.get(1)?, trace_id: r.get(2)?, api_key_id: r.get(3)?,
                key_name: r.get(4)?, channel_id: r.get(5)?, channel_name: r.get(6)?, role: r.get(7)?,
                request_model: r.get(8)?, upstream_model: r.get(9)?, protocol: r.get(10)?,
                status_code: r.get(11)?, input_tokens: r.get(12)?, output_tokens: r.get(13)?,
                latency_ms: r.get(14)?, is_stream: r.get::<_,i64>(15)? != 0, error: r.get(16)?,
                fallback: r.get::<_,i64>(17)? != 0, tool_calls: r.get(18)?, request_body: r.get(19)?,
                response_body: r.get(20)?, risk_level: r.get(21)?, risk_score: r.get(22)?,
                risk_summary: r.get(23)?, security_action: r.get(24)?,
                sanitized: r.get::<_,i64>(25)? != 0, blocked_reason: r.get(26)?, created_at: r.get(27)?,
            })
        )?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn insert_finding(&self, f: &RequestSecurityFinding) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO request_security_findings (id,log_id,phase,category,rule_id,severity,title,description,location,evidence_masked,evidence_hash,action,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![f.id, f.log_id, f.phase, f.category, f.rule_id, f.severity, f.title, f.description, f.location, f.evidence_masked, f.evidence_hash, f.action, f.created_at],
        )?;
        Ok(())
    }

    pub fn get_findings(&self, log_id: &str) -> AppResult<Vec<RequestSecurityFinding>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare("SELECT id,log_id,phase,category,rule_id,severity,title,description,location,evidence_masked,evidence_hash,action,created_at FROM request_security_findings WHERE log_id=?1 ORDER BY created_at ASC")?;
        let rows = stmt.query_map(params![log_id], |r| Ok(RequestSecurityFinding{
            id:r.get(0)?, log_id:r.get(1)?, phase:r.get(2)?, category:r.get(3)?, rule_id:r.get(4)?,
            severity:r.get(5)?, title:r.get(6)?, description:r.get(7)?, location:r.get(8)?,
            evidence_masked:r.get(9)?, evidence_hash:r.get(10)?, action:r.get(11)?, created_at:r.get(12)?,
        }))?;
        let mut out=Vec::new(); for x in rows { out.push(x?); } Ok(out)
    }

    pub fn seed_builtin_rules(&self, rules: &[BuiltinRule]) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        for r in rules {
            conn.execute(
                "INSERT OR IGNORE INTO security_builtin_rules (id,rule_id,category,severity,title,description,toggle_key,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![r.id, r.rule_id, r.category, r.severity, r.title, r.description, r.toggle_key, r.enabled as i64, r.created_at],
            )?;
        }
        Ok(())
    }

    pub fn list_builtin_rules(&self) -> AppResult<Vec<BuiltinRule>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare("SELECT id,rule_id,category,severity,title,description,toggle_key,enabled,created_at FROM security_builtin_rules ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |r| Ok(BuiltinRule {
            id: r.get(0)?, rule_id: r.get(1)?, category: r.get(2)?, severity: r.get(3)?,
            title: r.get(4)?, description: r.get(5)?, toggle_key: r.get(6)?,
            enabled: r.get::<_, i64>(7)? != 0, created_at: r.get(8)?,
        }))?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn update_builtin_rule(&self, id: &str, enabled: bool, severity: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE security_builtin_rules SET enabled=?2, severity=?3 WHERE id=?1",
            params![id, enabled as i64, severity],
        )?;
        Ok(())
    }

    pub fn reset_builtin_rules(&self, rules: &[BuiltinRule]) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM security_builtin_rules", [])?;
        drop(conn);
        self.seed_builtin_rules(rules)
    }

    pub fn create_custom_rule(&self, r: &CustomRule) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO security_custom_rules (id,rule_type,category,pattern,severity,action,enabled,description,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![r.id, r.rule_type, r.category, r.pattern, r.severity, r.action, r.enabled as i64, r.description, r.created_at],
        )?;
        Ok(())
    }

    pub fn update_custom_rule(&self, r: &CustomRule) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE security_custom_rules SET rule_type=?2,category=?3,pattern=?4,severity=?5,action=?6,enabled=?7,description=?8,created_at=?9 WHERE id=?1",
            params![r.id, r.rule_type, r.category, r.pattern, r.severity, r.action, r.enabled as i64, r.description, r.created_at],
        )?;
        Ok(())
    }

    pub fn list_custom_rules(&self) -> AppResult<Vec<CustomRule>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare("SELECT id,rule_type,category,pattern,severity,action,enabled,description,created_at FROM security_custom_rules ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| Ok(CustomRule {
            id: r.get(0)?, rule_type: r.get(1)?, category: r.get(2)?, pattern: r.get(3)?,
            severity: r.get(4)?, action: r.get(5)?, enabled: r.get::<_, i64>(6)? != 0,
            description: r.get(7)?, created_at: r.get(8)?,
        }))?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn set_custom_rule_enabled(&self, id: &str, enabled: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE security_custom_rules SET enabled=?2 WHERE id=?1",
            params![id, enabled as i64],
        )?;
        Ok(())
    }

    pub fn delete_custom_rule(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM security_custom_rules WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn stats(&self) -> AppResult<(i64,i64,i64,i64,i64,i64)> {
        // (today_requests, today_tokens, total_requests, total_tokens, active_channels, avg_latency_ms)
        let conn = self.db.conn();
        let conn = conn.lock();
        let today_start = chrono::Local::now().date_naive().and_hms_opt(0,0,0).unwrap().and_utc().timestamp();
        let (tr, tt): (i64,i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens+output_tokens),0) FROM request_logs WHERE created_at>=?1",
            [today_start], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let (ar, at): (i64,i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(input_tokens+output_tokens),0) FROM request_logs", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let ac: i64 = conn.query_row("SELECT COUNT(*) FROM channels WHERE enabled=1", [], |r| r.get(0))?;
        let lat: i64 = conn.query_row("SELECT CAST(COALESCE(AVG(latency_ms),0) AS INTEGER) FROM request_logs", [], |r| r.get(0))?;
        Ok((tr, tt, ar, at, ac, lat))
    }

    // 知识库 CRUD
    pub fn create_kb(&self, kb: &KnowledgeBase) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO knowledge_bases (id,name,description,embedding_channel_id,embedding_model,dim,doc_count,chunk_count,enabled,needs_reindex,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                kb.id, kb.name, kb.description, kb.embedding_channel_id, kb.embedding_model,
                kb.dim, kb.doc_count, kb.chunk_count, kb.enabled as i64, kb.needs_reindex as i64,
                kb.created_at, kb.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn list_kbs(&self) -> AppResult<Vec<KnowledgeBase>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,name,description,embedding_channel_id,embedding_model,dim,doc_count,chunk_count,enabled,needs_reindex,created_at,updated_at FROM knowledge_bases ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_kb)?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn get_kb_by_name(&self, name: &str) -> AppResult<Option<KnowledgeBase>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,name,description,embedding_channel_id,embedding_model,dim,doc_count,chunk_count,enabled,needs_reindex,created_at,updated_at FROM knowledge_bases WHERE name=?1",
        )?;
        let mut rows = stmt.query(params![name])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_kb(r)?))
        } else {
            Ok(None)
        }
    }

    pub fn get_kb(&self, id: &str) -> AppResult<Option<KnowledgeBase>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,name,description,embedding_channel_id,embedding_model,dim,doc_count,chunk_count,enabled,needs_reindex,created_at,updated_at FROM knowledge_bases WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_kb(r)?))
        } else {
            Ok(None)
        }
    }

    pub fn delete_kb(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM knowledge_bases WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn set_kb_status(&self, id: &str, enabled: bool) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE knowledge_bases SET enabled=?2 WHERE id=?1",
            params![id, enabled as i64],
        )?;
        Ok(())
    }

    pub fn rename_kb(&self, id: &str, name: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE knowledge_bases SET name=?2, updated_at=?3 WHERE id=?1",
            params![id, name, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn update_kb_embedding_channel(&self, id: &str, channel_id: Option<String>, model: &str) -> AppResult<bool> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT embedding_channel_id, embedding_model FROM knowledge_bases WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        let (old_channel_id, old_model): (Option<String>, String) = if let Some(r) = rows.next()? {
            (r.get(0)?, r.get(1)?)
        } else {
            return Ok(false);
        };
        let changed = old_channel_id != channel_id || old_model != model;
        if changed {
            conn.execute(
                "UPDATE knowledge_bases SET embedding_channel_id=?2, embedding_model=?3, needs_reindex=?4, updated_at=?5 WHERE id=?1",
                params![id, channel_id, model, true as i64, chrono::Utc::now().timestamp()],
            )?;
        }
        Ok(changed)
    }

    /// 重建成功后清除 needs_reindex 标记。
    pub fn mark_kb_reindexed(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE knowledge_bases SET needs_reindex=?2, updated_at=?3 WHERE id=?1",
            params![id, false as i64, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn update_kb_counts(&self, id: &str, doc_count: i64, chunk_count: i64) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE knowledge_bases SET doc_count=?2, chunk_count=?3 WHERE id=?1",
            params![id, doc_count, chunk_count],
        )?;
        Ok(())
    }

    pub fn insert_document(&self, doc: &KbDocument) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO kb_documents (id,kb_id,filename,file_type,size_bytes,chunk_count,status,error,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                doc.id, doc.kb_id, doc.filename, doc.file_type, doc.size_bytes,
                doc.chunk_count, doc.status, doc.error, doc.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_documents(&self, kb_id: &str) -> AppResult<Vec<KbDocument>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,kb_id,filename,file_type,size_bytes,chunk_count,status,error,created_at FROM kb_documents WHERE kb_id=?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![kb_id], row_to_kb_doc)?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn get_document(&self, id: &str) -> AppResult<Option<KbDocument>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,kb_id,filename,file_type,size_bytes,chunk_count,status,error,created_at FROM kb_documents WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_kb_doc(r)?))
        } else {
            Ok(None)
        }
    }

    pub fn update_document_status(&self, id: &str, status: &str, error: Option<&str>) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE kb_documents SET status=?2, error=?3 WHERE id=?1",
            params![id, status, error],
        )?;
        Ok(())
    }

    /// 摄取成功后把文档标记为 indexed,并回填其 chunk_count、清空 error。
    pub fn mark_document_indexed(&self, id: &str, chunk_count: i64) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE kb_documents SET status='indexed', chunk_count=?2, error=NULL WHERE id=?1",
            params![id, chunk_count],
        )?;
        Ok(())
    }

    pub fn delete_document(&self, id: &str) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute("DELETE FROM kb_documents WHERE id=?1", [id])?;
        Ok(())
    }

    /// 摄取回滚:按 doc_id 删除其全部 chunk。kb_chunks 的 DELETE 触发器会同步清理 FTS。
    pub fn delete_chunks_by_doc(&self, doc_id: &str) -> AppResult<usize> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let deleted = conn.execute("DELETE FROM kb_chunks WHERE doc_id=?1", params![doc_id])?;
        Ok(deleted)
    }

    pub fn insert_chunks(&self, chunks: &[KbChunk]) -> AppResult<()> {
        let conn = self.db.conn();
        let mut conn = conn.lock();
        let tx = conn.transaction()?;
        for chunk in chunks {
            tx.execute(
                "INSERT INTO kb_chunks (id,doc_id,kb_id,seq,symbol,content,token_count,embedding_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    chunk.id, chunk.doc_id, chunk.kb_id, chunk.seq, chunk.symbol,
                    chunk.content, chunk.token_count, chunk.embedding_id
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_chunks(&self, kb_id: &str) -> AppResult<Vec<KbChunk>> {
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,doc_id,kb_id,seq,symbol,content,token_count,embedding_id FROM kb_chunks WHERE kb_id=?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![kb_id], row_to_kb_chunk)?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn get_chunks_by_embedding_ids(&self, kb_id: &str, ids: &[i64]) -> AppResult<Vec<KbChunk>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.db.conn();
        let conn = conn.lock();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id,doc_id,kb_id,seq,symbol,content,token_count,embedding_id FROM kb_chunks WHERE kb_id=?1 AND embedding_id IN ({})",
            placeholders
        );
        let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(1 + ids.len());
        params.push(rusqlite::types::Value::Text(kb_id.into()));
        for id in ids {
            params.push((*id).into());
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), row_to_kb_chunk)?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn fts_search_chunks(&self, kb_id: &str, query: &str, top_k: usize) -> AppResult<Vec<(i64, f64)>> {
        let escaped = match fts5_escape(query) {
            Some(q) => q,
            None => return Ok(Vec::new()),
        };
        let conn = self.db.conn();
        let conn = conn.lock();
        let mut stmt = conn.prepare(
            "SELECT c.embedding_id, rank FROM kb_chunks_fts f JOIN kb_chunks c ON c.rowid=f.rowid WHERE f.content MATCH ?1 AND c.kb_id=?2 ORDER BY rank LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![escaped, kb_id, top_k as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows { out.push(r?); }
        Ok(out)
    }

    pub fn next_embedding_id(&self) -> AppResult<i64> {
        let conn = self.db.conn();
        let mut conn = conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE kb_meta SET value=value+1 WHERE key='next_embedding_id'",
            [],
        )?;
        let id: i64 = tx.query_row(
            "SELECT value FROM kb_meta WHERE key='next_embedding_id'",
            [],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(id)
    }

    /// 回写 chunk 的 embedding_id（重建索引时分配新 id 后更新）。
    ///
    /// kb_chunks_fts 是 content 外部内容表，更新 embedding_id 不改变 content，
    /// 触发器重新同步同一内容，不影响 FTS 检索。
    pub fn update_chunk_embedding_id(&self, chunk_id: &str, embedding_id: i64) -> AppResult<()> {
        let conn = self.db.conn();
        let conn = conn.lock();
        conn.execute(
            "UPDATE kb_chunks SET embedding_id=?2 WHERE id=?1",
            params![chunk_id, embedding_id],
        )?;
        Ok(())
    }
}

fn fts5_escape(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" "))
}

fn row_to_channel(r: &rusqlite::Row) -> rusqlite::Result<Channel> {
    let models_json: String = r.get(6)?;
    Ok(Channel {
        id: r.get(0)?,
        name: r.get(1)?,
        supplier: r.get(2)?,
        upstream_protocol: r.get(3)?,
        base_url: r.get(4)?,
        api_key: r.get(5)?,
        models: serde_json::from_str(&models_json).unwrap_or_default(),
        priority: r.get(7)?,
        weight: r.get(8)?,
        enabled: r.get::<_, i64>(9)? != 0,
        timeout_secs: r.get(10)?,
        total_calls: r.get(11)?,
        total_tokens: r.get(12)?,
        success_rate: r.get(13)?,
        avg_latency_ms: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
    })
}

fn row_to_kb(r: &rusqlite::Row) -> rusqlite::Result<KnowledgeBase> {
    Ok(KnowledgeBase {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        embedding_channel_id: r.get(3)?,
        embedding_model: r.get(4)?,
        dim: r.get(5)?,
        doc_count: r.get(6)?,
        chunk_count: r.get(7)?,
        enabled: r.get::<_, i64>(8)? != 0,
        needs_reindex: r.get::<_, i64>(9)? != 0,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

fn row_to_kb_doc(r: &rusqlite::Row) -> rusqlite::Result<KbDocument> {
    Ok(KbDocument {
        id: r.get(0)?,
        kb_id: r.get(1)?,
        filename: r.get(2)?,
        file_type: r.get(3)?,
        size_bytes: r.get(4)?,
        chunk_count: r.get(5)?,
        status: r.get(6)?,
        error: r.get(7)?,
        created_at: r.get(8)?,
    })
}

fn row_to_kb_chunk(r: &rusqlite::Row) -> rusqlite::Result<KbChunk> {
    Ok(KbChunk {
        id: r.get(0)?,
        doc_id: r.get(1)?,
        kb_id: r.get(2)?,
        seq: r.get(3)?,
        symbol: r.get(4)?,
        content: r.get(5)?,
        token_count: r.get(6)?,
        embedding_id: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str) -> Channel {
        Channel {
            id: id.into(), name: "n".into(), supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
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
        let conn = conn.lock();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM role_patterns", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 4);
    }

    #[test]
    fn channel_update_and_delete() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let mut c = ch("c1");
        repo.insert_channel(&c).unwrap();
        c.name = "updated".into();
        c.api_key = "sk-new".into();
        repo.update_channel(&c).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.name, "updated");
        assert_eq!(got.api_key, "sk-new");
        repo.delete_channel("c1").unwrap();
        assert!(repo.get_channel("c1").unwrap().is_none());
    }

    #[test]
    fn api_key_crud_and_quota() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: Some(1000), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        let keys = repo.list_api_keys().unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].name, "alice");

        repo.set_api_key_enabled("k1", false).unwrap();
        assert!(!repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap().enabled);
        repo.set_api_key_enabled("k1", true).unwrap();

        repo.update_quota("k1", Some(5000)).unwrap();
        assert_eq!(repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap().quota_total, Some(5000));
        repo.update_quota("k1", None).unwrap();
        assert_eq!(repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap().quota_total, None);

        repo.delete_api_key("k1").unwrap();
        assert!(repo.get_api_key_by_key("sk-lgw-a").unwrap().is_none());
        assert!(repo.list_api_keys().unwrap().is_empty());
    }

    #[test]
    fn consume_quota_atomic_caps_at_total() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: Some(10), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        assert!(repo.consume_quota("k1", 6).unwrap());   // 0+6<=10 -> true, used=6
        assert!(!repo.consume_quota("k1", 6).unwrap());  // 6+6>10 -> false, used stays 6
        let got = repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap();
        assert_eq!(got.quota_used, 6);
    }

    #[test]
    fn consume_quota_zero_tokens_increments_calls_without_changing_used() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: Some(100), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        assert!(repo.consume_quota("k1", 0).unwrap());
        let got = repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap();
        assert_eq!(got.quota_used, 0);
        assert_eq!(got.total_calls, 1);
        assert_eq!(got.total_tokens, 0);
    }

    #[test]
    fn consume_quota_large_value_and_over_cap_is_atomic() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: Some(100), quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        assert!(repo.consume_quota("k1", 99).unwrap());   // 0+99<=100 -> true, used=99
        assert!(!repo.consume_quota("k1", 100).unwrap()); // 99+100>100 -> false, used stays 99
        let got = repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap();
        assert_eq!(got.quota_used, 99);
        assert_eq!(got.total_calls, 1);
        assert_eq!(got.total_tokens, 99);
    }

    #[test]
    fn consume_quota_over_cap_does_not_decrement() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let k = ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: Some(50), quota_used: 40,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        };
        repo.insert_api_key(&k).unwrap();
        assert!(!repo.consume_quota("k1", 20).unwrap()); // 40+20>50 -> false
        let got = repo.get_api_key_by_key("sk-lgw-a").unwrap().unwrap();
        assert_eq!(got.quota_used, 40, "over-cap must not decrement quota");
        assert_eq!(got.total_calls, 0, "over-cap must not increment calls");
        assert_eq!(got.total_tokens, 0, "over-cap must not increment tokens");
    }

    #[test]
    fn record_channel_stats_sliding_window_updates_avg_and_success_rate() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let mut c = ch("c1");
        c.success_rate = 1.0;
        c.avg_latency_ms = 0;
        repo.insert_channel(&c).unwrap();

        repo.record_channel_stats("c1", 10, 100, true).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.total_calls, 1);
        assert_eq!(got.avg_latency_ms, 100);
        assert!((got.success_rate - 1.0).abs() < f64::EPSILON);

        repo.record_channel_stats("c1", 10, 200, false).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.total_calls, 2);
        assert_eq!(got.avg_latency_ms, 150);
        assert!((got.success_rate - 0.9).abs() < f64::EPSILON, "success_rate={}", got.success_rate);

        repo.record_channel_stats("c1", 10, 300, true).unwrap();
        let got = repo.get_channel("c1").unwrap().unwrap();
        assert_eq!(got.total_calls, 3);
        assert_eq!(got.avg_latency_ms, 200);
        assert!((got.success_rate - 0.91).abs() < f64::EPSILON, "success_rate={}", got.success_rate);
    }

    #[test]
    fn role_route_crud() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        let rr = RoleRoute {
            id: "rr1".into(), role: "coder".into(), channel_id: "ch1".into(),
            target_model: "gpt-4o".into(), enabled: true, updated_at: 1,
        };
        repo.upsert_role_route(&rr).unwrap();
        let routes = repo.list_role_routes().unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].role, "coder");

        repo.delete_role_route("coder").unwrap();
        assert!(repo.list_role_routes().unwrap().is_empty());
    }

    #[test]
    fn role_pattern_upsert_and_delete() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let p = RolePattern {
            id: "rp1".into(), pattern: ".*code.*".into(), role: "coder".into(),
            priority: 10, enabled: true,
        };
        repo.upsert_role_pattern(&p).unwrap();
        let patterns = repo.list_role_patterns().unwrap();
        assert!(patterns.iter().any(|x| x.id == "rp1"));

        let mut p2 = p.clone();
        p2.pattern = ".*review.*".into();
        repo.upsert_role_pattern(&p2).unwrap();
        let got = repo.list_role_patterns().unwrap().into_iter().find(|x| x.id == "rp1").unwrap();
        assert_eq!(got.pattern, ".*review.*");

        repo.delete_role_pattern("rp1").unwrap();
        assert!(!repo.list_role_patterns().unwrap().iter().any(|x| x.id == "rp1"));
    }

    fn make_log(seq: i64, model: &str, tokens: i64, latency: i64, created_at: i64) -> RequestLog {
        RequestLog {
            id: format!("l{}", seq), seq, trace_id: format!("t{}", seq),
            api_key_id: Some("k1".into()), key_name: Some("alice".into()),
            channel_id: Some("ch1".into()), channel_name: Some("ch".into()),
            role: Some("coder".into()), request_model: Some(model.into()),
            upstream_model: Some(model.into()), protocol: "openai".into(),
            status_code: Some(200), input_tokens: tokens, output_tokens: tokens,
            latency_ms: latency, is_stream: false, error: None, fallback: false,
            tool_calls: None, request_body: None, response_body: None,
            risk_level: "clean".into(), risk_score: 0, risk_summary: None,
            security_action: "allow".into(), sanitized: false, blocked_reason: None,
            created_at,
        }
    }

    fn make_log_with(seq: i64, status: i64, channel_id: &str, risk_level: &str, created_at: i64) -> RequestLog {
        RequestLog {
            id: format!("l{}", seq), seq, trace_id: format!("t{}", seq),
            api_key_id: Some("k1".into()), key_name: Some("alice".into()),
            channel_id: Some(channel_id.into()), channel_name: Some("ch".into()),
            role: Some("coder".into()), request_model: Some("gpt-4o".into()),
            upstream_model: Some("gpt-4o".into()), protocol: "openai".into(),
            status_code: Some(status), input_tokens: 10, output_tokens: 10,
            latency_ms: 100, is_stream: false, error: None, fallback: false,
            tool_calls: None, request_body: None, response_body: None,
            risk_level: risk_level.into(), risk_score: 0, risk_summary: None,
            security_action: "allow".into(), sanitized: false, blocked_reason: None,
            created_at,
        }
    }

    #[test]
    fn log_query_and_pagination() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 1)).unwrap();
        repo.insert_log(&make_log(2, "gpt-3.5", 20, 200, 2)).unwrap();
        repo.insert_log(&make_log(3, "gpt-4o", 30, 300, 3)).unwrap();

        assert_eq!(repo.count_logs(&LogFilter::default()).unwrap(), 3);
        assert_eq!(repo.count_logs(&LogFilter { keyword: Some("gpt-4o".into()), ..Default::default() }).unwrap(), 2);

        let page = repo.list_logs(&LogFilter::default(), 2, 0).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].seq, 3);
        assert_eq!(page[1].seq, 2);

        let page = repo.list_logs(&LogFilter { keyword: Some("gpt-4o".into()), ..Default::default() }, 10, 0).unwrap();
        assert_eq!(page.len(), 2);
    }

    #[test]
    fn list_logs_filter_multi_condition_and() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_channel(&ch("ch2")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();

        repo.insert_log(&make_log_with(1, 200, "ch1", "high", 1)).unwrap();
        repo.insert_log(&make_log_with(2, 200, "ch1", "low", 2)).unwrap();
        repo.insert_log(&make_log_with(3, 500, "ch1", "high", 3)).unwrap();
        repo.insert_log(&make_log_with(4, 200, "ch2", "high", 4)).unwrap();

        let filter = LogFilter {
            channel_id: Some("ch1".into()),
            risk_level: Some("high".into()),
            status: Some(StatusClass::Success),
            ..Default::default()
        };
        let items = repo.list_logs(&filter, 10, 0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].seq, 1);
        assert_eq!(repo.count_logs(&filter).unwrap(), 1);
    }

    #[test]
    fn list_logs_filter_date_range_and_status_class() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();

        repo.insert_log(&make_log_with(1, 200, "ch1", "clean", 100)).unwrap();
        repo.insert_log(&make_log_with(2, 500, "ch1", "clean", 200)).unwrap();
        repo.insert_log(&make_log_with(3, 503, "ch1", "clean", 300)).unwrap();

        let filter = LogFilter {
            after: Some(150),
            before: Some(250),
            status: Some(StatusClass::ServerError),
            ..Default::default()
        };
        let items = repo.list_logs(&filter, 10, 0).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].seq, 2);
        assert_eq!(items[0].status_code, Some(500));
        assert_eq!(repo.count_logs(&filter).unwrap(), 1);
    }

    #[test]
    fn list_logs_keyword_backward_compatible() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 1)).unwrap();
        repo.insert_log(&make_log(2, "gpt-3.5", 20, 200, 2)).unwrap();
        repo.insert_log(&make_log(3, "gpt-4o", 30, 300, 3)).unwrap();

        let filter = LogFilter { keyword: Some("gpt-4o".into()), ..Default::default() };
        assert_eq!(repo.count_logs(&filter).unwrap(), 2);
        let items = repo.list_logs(&filter, 10, 0).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|l| l.request_model.as_deref() == Some("gpt-4o")));
    }

    #[test]
    fn stats_aggregation() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        let mut c2 = ch("ch2");
        c2.enabled = false;
        repo.insert_channel(&c2).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();

        let today = chrono::Local::now().timestamp();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, today)).unwrap();
        repo.insert_log(&make_log(2, "gpt-4o", 20, 200, today - 86400 * 2)).unwrap();

        let (tr, tt, ar, at, ac, lat) = repo.stats().unwrap();
        assert_eq!(tr, 1);
        assert_eq!(tt, 20);
        assert_eq!(ar, 2);
        assert_eq!(at, 60);
        assert_eq!(ac, 1);
        assert_eq!(lat, 150);
    }

    fn make_log_risk(seq: i64, model: &str, risk_level: &str, risk_score: i64) -> RequestLog {
        RequestLog {
            id: format!("l{}", seq), seq, trace_id: format!("t{}", seq),
            api_key_id: Some("k1".into()), key_name: Some("alice".into()),
            channel_id: Some("ch1".into()), channel_name: Some("ch".into()),
            role: Some("coder".into()), request_model: Some(model.into()),
            upstream_model: Some(model.into()), protocol: "openai".into(),
            status_code: Some(200), input_tokens: 10, output_tokens: 10,
            latency_ms: 100, is_stream: false, error: None, fallback: false,
            tool_calls: None, request_body: None, response_body: None,
            risk_level: risk_level.into(), risk_score,
            risk_summary: Some("summary".into()),
            security_action: "block".into(),
            sanitized: true,
            blocked_reason: Some("reason".into()),
            created_at: 1,
        }
    }

    #[test]
    fn request_log_risk_columns_roundtrip() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();

        repo.insert_log(&make_log_risk(1, "gpt-4o", "high", 85)).unwrap();
        let logs = repo.list_logs(&LogFilter::default(), 10, 0).unwrap();
        assert_eq!(logs.len(), 1);
        let got = &logs[0];
        assert_eq!(got.risk_level, "high");
        assert_eq!(got.risk_score, 85);
        assert_eq!(got.risk_summary, Some("summary".into()));
        assert_eq!(got.security_action, "block");
        assert!(got.sanitized);
        assert_eq!(got.blocked_reason, Some("reason".into()));
    }

    #[test]
    fn finding_roundtrip() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 1)).unwrap();

        let finding = crate::db::models::RequestSecurityFinding {
            id: "f1".into(), log_id: "l1".into(), phase: "request".into(),
            category: "prompt_injection".into(), rule_id: "rule-1".into(),
            severity: "high".into(), title: "Detected".into(),
            description: Some("desc".into()), location: Some("messages[0]".into()),
            evidence_masked: Some("***".into()), evidence_hash: Some("hash".into()),
            action: Some("block".into()), created_at: 1,
        };
        repo.insert_finding(&finding).unwrap();

        let findings = repo.get_findings("l1").unwrap();
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].id, "f1");
        assert_eq!(findings[0].evidence_masked, Some("***".into()));
    }

    fn insert_raw_finding(repo: &Repository, id: &str, log_id: &str, created_at: i64) {
        let conn = repo.db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO request_security_findings (id, log_id, phase, category, rule_id, severity, title, description, location, evidence_masked, evidence_hash, action, created_at) VALUES (?1, ?2, 'request', 'secret', 'rule-1', 'high', 't', NULL, NULL, NULL, NULL, NULL, ?3)",
            params![id, log_id, created_at],
        ).unwrap();
    }

    fn count_table(repo: &Repository, table: &str) -> i64 {
        let conn = repo.db.conn();
        let conn = conn.lock();
        conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn delete_logs_before_cascades_findings() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        // log at 100 and 200; only 100 is before cutoff 150
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 100)).unwrap();
        repo.insert_log(&make_log(2, "gpt-4o", 10, 100, 200)).unwrap();
        insert_raw_finding(&repo, "f1", "l1", 100);
        insert_raw_finding(&repo, "f2", "l2", 200);

        let deleted = repo.delete_logs_before(150).unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(count_table(&repo, "request_logs"), 1);
        assert_eq!(count_table(&repo, "request_security_findings"), 1);
        assert!(repo.get_findings("l1").unwrap().is_empty());
        assert_eq!(repo.get_findings("l2").unwrap().len(), 1);
    }

    #[test]
    fn delete_logs_before_boundary_exclusive() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 1000)).unwrap();
        insert_raw_finding(&repo, "f1", "l1", 1000);

        // created_at == ts must be kept (strict less-than)
        let deleted = repo.delete_logs_before(1000).unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(count_table(&repo, "request_logs"), 1);
        assert_eq!(count_table(&repo, "request_security_findings"), 1);
    }

    #[test]
    fn clear_logs_empties_both_tables() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(), key: "sk-lgw-a".into(), name: "alice".into(),
            enabled: true, quota_total: None, quota_used: 0,
            total_calls: 0, total_tokens: 0, created_at: 1, last_used_at: None,
        }).unwrap();
        repo.insert_log(&make_log(1, "gpt-4o", 10, 100, 100)).unwrap();
        repo.insert_log(&make_log(2, "gpt-4o", 10, 100, 200)).unwrap();
        insert_raw_finding(&repo, "f1", "l1", 100);
        insert_raw_finding(&repo, "f2", "l2", 200);

        let deleted = repo.clear_logs().unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(count_table(&repo, "request_logs"), 0);
        assert_eq!(count_table(&repo, "request_security_findings"), 0);
    }

    #[test]
    fn builtin_rule_seed_idempotent() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let rules = vec![crate::db::models::BuiltinRule {
            id: "b1".into(), rule_id: "PI-001".into(), category: "prompt_injection".into(),
            severity: "high".into(), title: "PI".into(), description: Some("d".into()),
            toggle_key: Some("pi".into()), enabled: true, created_at: 1,
        }];
        repo.seed_builtin_rules(&rules).unwrap();
        let listed = repo.list_builtin_rules().unwrap();
        assert_eq!(listed.len(), 1);

        repo.seed_builtin_rules(&rules).unwrap();
        let listed2 = repo.list_builtin_rules().unwrap();
        assert_eq!(listed2.len(), 1);
    }

    #[test]
    fn custom_rule_crud_and_toggle() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let rule = crate::db::models::CustomRule {
            id: "c1".into(), rule_type: "keyword".into(), category: "secret".into(),
            pattern: "password".into(), severity: "medium".into(), action: "warn".into(),
            enabled: true, description: Some("d".into()), created_at: 1,
        };
        repo.create_custom_rule(&rule).unwrap();
        let listed = repo.list_custom_rules().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].enabled);

        repo.set_custom_rule_enabled("c1", false).unwrap();
        let listed = repo.list_custom_rules().unwrap();
        assert!(!listed[0].enabled);

        repo.delete_custom_rule("c1").unwrap();
        assert!(repo.list_custom_rules().unwrap().is_empty());
    }

    fn make_log_stats(
        seq: i64,
        status: i64,
        channel_id: &str,
        channel_name: &str,
        key_name: &str,
        risk_level: &str,
        input_tokens: i64,
        output_tokens: i64,
        created_at: i64,
    ) -> RequestLog {
        RequestLog {
            id: format!("l{}", seq),
            seq,
            trace_id: format!("t{}", seq),
            api_key_id: Some("k1".into()),
            key_name: Some(key_name.into()),
            channel_id: Some(channel_id.into()),
            channel_name: Some(channel_name.into()),
            role: Some("coder".into()),
            request_model: Some("gpt-4o".into()),
            upstream_model: Some("gpt-4o".into()),
            protocol: "openai".into(),
            status_code: Some(status),
            input_tokens,
            output_tokens,
            latency_ms: 100,
            is_stream: false,
            error: None,
            fallback: false,
            tool_calls: None,
            request_body: None,
            response_body: None,
            risk_level: risk_level.into(),
            risk_score: 0,
            risk_summary: None,
            security_action: "allow".into(),
            sanitized: false,
            blocked_reason: None,
            created_at,
        }
    }

    #[test]
    fn log_stats_aggregates_correctly() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_channel(&ch("ch2")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(),
            key: "sk-lgw-a".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        })
        .unwrap();

        repo.insert_log(&make_log_stats(1, 200, "ch1", "prod-channel", "alice", "clean", 10, 5, 1))
            .unwrap();
        repo.insert_log(&make_log_stats(2, 200, "ch1", "prod-channel", "alice", "low", 20, 10, 2))
            .unwrap();
        repo.insert_log(&make_log_stats(3, 400, "ch1", "prod-channel", "bob", "high", 30, 15, 3))
            .unwrap();
        repo.insert_log(&make_log_stats(4, 500, "ch2", "dev-channel", "bob", "high", 40, 20, 4))
            .unwrap();
        repo.insert_log(&make_log_stats(5, 200, "ch2", "dev-channel", "alice", "clean", 50, 25, 5))
            .unwrap();

        let stats = repo.log_stats(&LogFilter::default()).unwrap();
        assert_eq!(stats.total_calls, 5);
        assert_eq!(stats.total_input_tokens, 150);
        assert_eq!(stats.total_output_tokens, 75);
        assert_eq!(stats.success_count, 3);

        assert_eq!(stats.risk_distribution, vec![
            ("clean".to_string(), 2),
            ("high".to_string(), 2),
            ("low".to_string(), 1),
        ]);
        assert_eq!(stats.top_channels, vec![
            ("prod-channel".to_string(), 3),
            ("dev-channel".to_string(), 2),
        ]);
        assert_eq!(stats.top_api_keys, vec![
            ("alice".to_string(), 3),
            ("bob".to_string(), 2),
        ]);
    }

    #[test]
    fn log_stats_respects_filter() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_channel(&ch("ch2")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(),
            key: "sk-lgw-a".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        })
        .unwrap();

        repo.insert_log(&make_log_stats(1, 200, "ch1", "prod-channel", "alice", "clean", 10, 5, 1))
            .unwrap();
        repo.insert_log(&make_log_stats(2, 200, "ch1", "prod-channel", "alice", "low", 20, 10, 2))
            .unwrap();
        repo.insert_log(&make_log_stats(3, 400, "ch1", "prod-channel", "bob", "high", 30, 15, 3))
            .unwrap();
        repo.insert_log(&make_log_stats(4, 500, "ch2", "dev-channel", "bob", "high", 40, 20, 4))
            .unwrap();
        repo.insert_log(&make_log_stats(5, 200, "ch2", "dev-channel", "alice", "clean", 50, 25, 5))
            .unwrap();

        let stats = repo
            .log_stats(&LogFilter {
                channel_id: Some("ch2".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(stats.total_calls, 2);
        assert_eq!(stats.total_input_tokens, 90);
        assert_eq!(stats.total_output_tokens, 45);
        assert_eq!(stats.success_count, 1);

        assert_eq!(stats.risk_distribution, vec![
            ("clean".to_string(), 1),
            ("high".to_string(), 1),
        ]);
        assert_eq!(stats.top_channels, vec![("dev-channel".to_string(), 2)]);
        assert_eq!(stats.top_api_keys, vec![
            ("alice".to_string(), 1),
            ("bob".to_string(), 1),
        ]);
    }

    #[test]
    fn log_timeseries_buckets_correctly() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(),
            key: "sk-lgw-a".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        })
        .unwrap();

        // Bucket 0: two calls
        repo.insert_log(&make_log_stats(1, 200, "ch1", "prod-channel", "alice", "clean", 10, 5, 5))
            .unwrap();
        repo.insert_log(&make_log_stats(2, 200, "ch1", "prod-channel", "alice", "low", 20, 10, 10))
            .unwrap();
        // Bucket 60: one error + one high risk
        repo.insert_log(&make_log_stats(3, 500, "ch1", "prod-channel", "bob", "high", 30, 15, 65))
            .unwrap();
        // Bucket 120: one critical
        repo.insert_log(&make_log_stats(4, 200, "ch1", "prod-channel", "alice", "critical", 40, 20, 120))
            .unwrap();

        let series = repo.log_timeseries(&LogFilter::default(), 60).unwrap();
        assert_eq!(series.len(), 3);

        assert_eq!(series[0].bucket, 0);
        assert_eq!(series[0].calls, 2);
        assert_eq!(series[0].input_tokens, 30);
        assert_eq!(series[0].output_tokens, 15);
        assert_eq!(series[0].error_count, 0);
        assert_eq!(series[0].risk_counts.get("clean"), Some(&1));
        assert_eq!(series[0].risk_counts.get("low"), Some(&1));
        assert_eq!(series[0].risk_counts.get("high"), Some(&0));

        assert_eq!(series[1].bucket, 60);
        assert_eq!(series[1].calls, 1);
        assert_eq!(series[1].input_tokens, 30);
        assert_eq!(series[1].output_tokens, 15);
        assert_eq!(series[1].error_count, 1);
        assert_eq!(series[1].risk_counts.get("high"), Some(&1));
        assert_eq!(series[1].risk_counts.get("clean"), Some(&0));

        assert_eq!(series[2].bucket, 120);
        assert_eq!(series[2].calls, 1);
        assert_eq!(series[2].input_tokens, 40);
        assert_eq!(series[2].output_tokens, 20);
        assert_eq!(series[2].error_count, 0);
        assert_eq!(series[2].risk_counts.get("critical"), Some(&1));

        // Verify all six fixed risk levels are present in every bucket.
        let expected_levels = ["clean", "info", "low", "medium", "high", "critical"];
        for bucket in &series {
            assert_eq!(bucket.risk_counts.len(), 6);
            for level in &expected_levels {
                assert!(bucket.risk_counts.contains_key(*level));
            }
        }
    }

    #[test]
    fn log_timeseries_empty_when_no_match() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_channel(&ch("ch1")).unwrap();
        repo.insert_api_key(&ApiKey {
            id: "k1".into(),
            key: "sk-lgw-a".into(),
            name: "alice".into(),
            enabled: true,
            quota_total: None,
            quota_used: 0,
            total_calls: 0,
            total_tokens: 0,
            created_at: 1,
            last_used_at: None,
        })
        .unwrap();

        repo.insert_log(&make_log_stats(1, 200, "ch1", "prod-channel", "alice", "clean", 10, 5, 5))
            .unwrap();

        let filter = LogFilter {
            api_key_id: Some("non-existent".into()),
            ..Default::default()
        };
        let series = repo.log_timeseries(&filter, 60).unwrap();
        assert!(series.is_empty());
    }

    // 知识库测试
    fn kb(id: &str, name: &str) -> KnowledgeBase {
        KnowledgeBase {
            id: id.into(), name: name.into(), description: None,
            embedding_channel_id: None, embedding_model: "text-embedding-3-small".into(),
            dim: 1536, doc_count: 0, chunk_count: 0, enabled: true,
            created_at: 1, updated_at: 1, needs_reindex: false,
        }
    }

    fn kb_doc(id: &str, kb_id: &str, filename: &str) -> KbDocument {
        KbDocument {
            id: id.into(), kb_id: kb_id.into(), filename: filename.into(),
            file_type: "txt".into(), size_bytes: 100, chunk_count: 0,
            status: "indexed".into(), error: None, created_at: 1,
        }
    }

    fn kb_chunk(id: &str, doc_id: &str, kb_id: &str, seq: i64, content: &str, emb_id: i64) -> KbChunk {
        KbChunk {
            id: id.into(), doc_id: doc_id.into(), kb_id: kb_id.into(),
            seq, symbol: None, content: content.into(), token_count: 10, embedding_id: emb_id,
        }
    }

    #[test]
    fn kb_create_and_get() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let kb = kb("kb1", "my-kb");
        repo.create_kb(&kb).unwrap();
        let got = repo.get_kb("kb1").unwrap().unwrap();
        assert_eq!(got.name, "my-kb");
        assert_eq!(got.dim, 1536);
        assert!(got.enabled);

        let by_name = repo.get_kb_by_name("my-kb").unwrap().unwrap();
        assert_eq!(by_name.id, "kb1");

        let list = repo.list_kbs().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "kb1");
    }

    #[test]
    fn kb_delete_cascades() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.create_kb(&kb("kb1", "my-kb")).unwrap();
        repo.insert_document(&kb_doc("d1", "kb1", "a.txt")).unwrap();
        repo.insert_chunks(&[
            kb_chunk("c1", "d1", "kb1", 0, "hello world", 1),
            kb_chunk("c2", "d1", "kb1", 1, "foo bar", 2),
        ]).unwrap();

        assert_eq!(count_table(&repo, "kb_documents"), 1);
        assert_eq!(count_table(&repo, "kb_chunks"), 2);

        repo.delete_kb("kb1").unwrap();
        assert!(repo.get_kb("kb1").unwrap().is_none());
        assert_eq!(count_table(&repo, "kb_documents"), 0);
        assert_eq!(count_table(&repo, "kb_chunks"), 0);
        // FTS 同步清理
        let conn = repo.db.conn();
        let conn = conn.lock();
        let fts: i64 = conn.query_row("SELECT COUNT(*) FROM kb_chunks_fts", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
    }

    #[test]
    fn kb_fts_trigger_syncs() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.create_kb(&kb("kb1", "my-kb")).unwrap();
        repo.insert_document(&kb_doc("d1", "kb1", "a.txt")).unwrap();
        repo.insert_chunks(&[
            kb_chunk("c1", "d1", "kb1", 0, "unique keyword alpha", 1),
            kb_chunk("c2", "d1", "kb1", 1, "beta gamma", 2),
        ]).unwrap();

        {
            let conn = repo.db.conn();
            let conn = conn.lock();
            let hits: i64 = conn
                .query_row("SELECT COUNT(*) FROM kb_chunks_fts WHERE content MATCH ?", ["alpha"], |r| r.get(0))
                .unwrap();
            assert_eq!(hits, 1);
        }

        // delete 后 FTS 应同步删除
        repo.delete_document("d1").unwrap();
        {
            let conn = repo.db.conn();
            let conn = conn.lock();
            let hits: i64 = conn
                .query_row("SELECT COUNT(*) FROM kb_chunks_fts WHERE content MATCH ?", ["alpha"], |r| r.get(0))
                .unwrap();
            assert_eq!(hits, 0);
        }
    }

    #[test]
    fn fts_search_chunks_returns_matches() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.create_kb(&kb("kb1", "my-kb")).unwrap();
        repo.insert_document(&kb_doc("d1", "kb1", "a.txt")).unwrap();
        repo.insert_chunks(&[
            kb_chunk("c1", "d1", "kb1", 0, "unique keyword alpha", 1),
            kb_chunk("c2", "d1", "kb1", 1, "beta gamma", 2),
            kb_chunk("c3", "d1", "kb1", 2, "alpha beta keyword", 3),
            kb_chunk("c4", "d1", "kb1", 3, "under_score foo-bar", 4),
        ]).unwrap();

        let hits = repo.fts_search_chunks("kb1", "alpha", 10).unwrap();
        assert_eq!(hits.len(), 2);
        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&3));
        // rank 越低越相关，应排在前面
        assert!(hits[0].1 <= hits[1].1);

        // 下划线保留，应能命中
        let hits = repo.fts_search_chunks("kb1", "under_score", 10).unwrap();
        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&4), "underscore should be preserved in fts5_escape");

        // 连字符保留并正确切分，应能命中
        let hits = repo.fts_search_chunks("kb1", "foo-bar", 10).unwrap();
        let ids: Vec<i64> = hits.iter().map(|(id, _)| *id).collect();
        assert!(ids.contains(&4), "hyphen should not break tokenization");
    }

    #[test]
    fn kb_next_embedding_id_monotonic() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let a = repo.next_embedding_id().unwrap();
        let b = repo.next_embedding_id().unwrap();
        let c = repo.next_embedding_id().unwrap();
        assert!(a < b && b < c, "embedding ids must be strictly monotonic: {a} {b} {c}");
    }
}
