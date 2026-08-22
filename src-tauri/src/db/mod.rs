pub mod models;
pub mod repository;

use crate::error::AppResult;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/001_init.sql"),
    include_str!("../../migrations/002_security.sql"),
    include_str!("../../migrations/003_logs.sql"),
    include_str!("../../migrations/004_knowledge.sql"),
    include_str!("../../migrations/005_channel_protocol.sql"),
    include_str!("../../migrations/006_kb_needs_reindex.sql"),
];

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn new_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // 记录已应用版本
        conn.execute_batch("CREATE TABLE IF NOT EXISTS _migrations(version INTEGER PRIMARY KEY);")?;
        let applied: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM _migrations",
            [],
            |r| r.get(0),
        )?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let version = (i + 1) as i64;
            if version > applied {
                conn.execute_batch(sql)?;
                conn.execute("INSERT INTO _migrations(version) VALUES (?1)", [version])?;
            }
        }
        Ok(())
    }

    pub fn conn(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }
}
