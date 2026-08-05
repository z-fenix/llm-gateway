use crate::db::repository::Repository;
use crate::db::Db;
use std::sync::{Arc, RwLock};

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub repo: Repository,
    pub http: reqwest::Client,
    /// 全局兜底：(channel_id, model)
    pub fallback: Arc<RwLock<Option<(String, String)>>>,
    pub retry_count: usize,
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
        }
    }
}
