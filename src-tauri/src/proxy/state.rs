use crate::db::repository::Repository;
use crate::db::Db;
use crate::security::SecuritySettings;
use std::sync::Arc;
use parking_lot::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub repo: Repository,
    pub http: reqwest::Client,
    /// 全局兜底：(channel_id, model)
    pub fallback: Arc<RwLock<Option<(String, String)>>>,
    pub retry_count: usize,
    pub security: Arc<RwLock<SecuritySettings>>,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let repo = Repository::new(db.clone());
        Self {
            db,
            repo,
            http: reqwest::Client::new(),
            fallback: Arc::new(RwLock::new(None)),
            retry_count: 2,
            security: Arc::new(RwLock::new(SecuritySettings::default())),
        }
    }
}
