use crate::db::repository::Repository;
use crate::db::Db;
use crate::security::SecuritySettings;
use std::path::PathBuf;
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
    /// 全局默认 embedding 渠道 id（从 store `rag.default_embedding_channel` 加载）
    pub default_embedding_channel: Arc<RwLock<Option<String>>>,
    /// 知识库 usearch 索引文件存放目录（生产为 app_data_dir/kb，测试用临时目录）
    pub kb_index_dir: Arc<RwLock<PathBuf>>,
}

impl AppState {
    pub fn new(db: Db) -> Self {
        let repo = Repository::new(db.clone());
        // 本机/回环地址永不走系统代理：本地网关常被代理拦截 127.0.0.1，导致转发 503。
        // 真实上游(公网域名)仍走系统代理。
        let http = reqwest::Client::builder()
            // 本地网关不使用系统代理:本机代理(如 127.0.0.1:9098)会拦截回环与上游请求导致 503。
            // 网关应直连上游(真实渠道 base_url 都是公网/内网直连可达)。
            .no_proxy()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let kb_index_dir = std::env::temp_dir().join("llm-gateway").join("kb");
        Self {
            db,
            repo,
            http,
            fallback: Arc::new(RwLock::new(None)),
            retry_count: 2,
            security: Arc::new(RwLock::new(SecuritySettings::default())),
            default_embedding_channel: Arc::new(RwLock::new(None)),
            kb_index_dir: Arc::new(RwLock::new(kb_index_dir)),
        }
    }
}
