pub mod claude_code;

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct CliWriteResult {
    pub path: String,
    pub changed_keys: Vec<String>,
    pub backup_path: Option<String>,
    pub env_instructions: Option<String>,
}

/// 写文件前备份已存在文件为 `<文件名>.bak`,返回备份路径。
pub fn backup_and_write(path: &Path, content: &str) -> Result<Option<String>, String> {
    let backup_path = if path.exists() {
        let fname = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "invalid file name".to_string())?;
        let bak = path.with_file_name(format!("{}.bak", fname));
        std::fs::copy(path, &bak).map_err(|e| format!("backup {}: {}", bak.display(), e))?;
        Some(bak.display().to_string())
    } else {
        None
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(backup_path)
}
