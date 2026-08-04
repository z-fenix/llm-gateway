use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("db error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("http error: {0}")]
    Http(String),
    #[error("{0}")]
    Msg(String),
}

pub type AppResult<T> = Result<T, AppError>;
