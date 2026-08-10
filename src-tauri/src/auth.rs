use crate::db::models::ApiKey;
use crate::db::repository::Repository;
use crate::error::AppResult;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum AuthError {
    #[error("invalid_api_key")]
    Invalid,
    #[error("api_key_disabled")]
    Disabled,
    #[error("quota_exceeded")]
    QuotaExceeded,
}

/// 校验密钥：存在 → 启用 → 配额未超。返回密钥记录供后续路由/日志使用。
/// 外层 `AppError` 表示 DB/基础设施失败；内层 `AuthError` 表示三种认证结果。
pub fn authorize(repo: &Repository, key: &str) -> AppResult<Result<ApiKey, AuthError>> {
    let k = repo.get_api_key_by_key(key)?;
    let k = match k {
        Some(k) => k,
        None => return Ok(Err(AuthError::Invalid)),
    };
    if !k.enabled {
        return Ok(Err(AuthError::Disabled));
    }
    if let Some(total) = k.quota_total {
        if k.quota_used >= total {
            return Ok(Err(AuthError::QuotaExceeded));
        }
    }
    Ok(Ok(k))
}

/// 生成本地密钥：sk-lgw-<32 hex>
pub fn generate_key() -> String {
    let hex: String = uuid::Uuid::new_v4().simple().to_string();
    format!("sk-lgw-{}", hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn repo_with_key(k: &ApiKey) -> Repository {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        repo.insert_api_key(k).unwrap();
        repo
    }

    fn base_key() -> ApiKey {
        ApiKey {
            id: "k1".into(), key: "sk-lgw-x".into(), name: "a".into(), enabled: true,
            quota_total: None, quota_used: 0, total_calls: 0, total_tokens: 0,
            created_at: 1, last_used_at: None,
        }
    }

    #[test]
    fn generate_key_format() {
        let k = generate_key();
        assert!(k.starts_with("sk-lgw-"));
        assert_eq!(k.len(), "sk-lgw-".len() + 32);
    }

    #[test]
    fn authorize_happy_and_unlimited_quota() {
        let repo = repo_with_key(&base_key());
        assert!(authorize(&repo, "sk-lgw-x").unwrap().is_ok());
    }

    #[test]
    fn authorize_invalid() {
        let repo = repo_with_key(&base_key());
        assert_eq!(
            authorize(&repo, "nope").unwrap().unwrap_err(),
            AuthError::Invalid
        );
    }

    #[test]
    fn authorize_disabled() {
        let mut k = base_key();
        k.enabled = false;
        let repo = repo_with_key(&k);
        assert_eq!(
            authorize(&repo, "sk-lgw-x").unwrap().unwrap_err(),
            AuthError::Disabled
        );
    }

    #[test]
    fn authorize_quota_exceeded() {
        let mut k = base_key();
        k.quota_total = Some(100);
        k.quota_used = 100;
        let repo = repo_with_key(&k);
        assert_eq!(
            authorize(&repo, "sk-lgw-x").unwrap().unwrap_err(),
            AuthError::QuotaExceeded
        );
        // 未超额则通过
        let mut k2 = base_key();
        k2.quota_total = Some(100);
        k2.quota_used = 50;
        let repo2 = repo_with_key(&k2);
        assert!(authorize(&repo2, "sk-lgw-x").unwrap().is_ok());
    }

    #[test]
    fn authorize_db_error_propagates() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        {
            let conn = repo.db.conn();
            let conn = conn.lock();
            conn.execute("DROP TABLE api_keys", []).unwrap();
        }
        let result = authorize(&repo, "sk-lgw-x");
        // 必须是外层 Err(AppError::...)，不能是 Ok(Err(AuthError::Invalid))
        assert!(result.is_err());
        assert!(!matches!(result, Ok(Err(AuthError::Invalid))));
    }

    #[test]
    fn consume_quota_accumulates() {
        let repo = repo_with_key(&base_key());
        repo.consume_quota("k1", 30).unwrap();
        repo.consume_quota("k1", 20).unwrap();
        let got = repo.get_api_key_by_key("sk-lgw-x").unwrap().unwrap();
        assert_eq!(got.quota_used, 50);
        assert_eq!(got.total_calls, 2);
        assert!(got.last_used_at.is_some());
    }
}
