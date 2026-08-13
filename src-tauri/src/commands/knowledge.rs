use crate::db::models::{KbDocument, KnowledgeBase};
use crate::knowledge::chunk::{detect_file_type, FileType};
use crate::knowledge::index::VectorIndex;
use crate::knowledge::retrieve::{retrieve, RetrievedChunk};
use crate::knowledge::settings::RagSettings;
use crate::proxy::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use tauri::State;
use tauri_plugin_store::StoreExt;

const SEARCH_TOP_N: usize = 10;

pub(crate) fn file_type_str(filename: &str) -> &'static str {
    match detect_file_type(filename) {
        FileType::Markdown => "md",
        FileType::Code => "code",
        FileType::Text => "txt",
    }
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|e| format!("invalid base64 content: {e}"))
}

pub(crate) fn kb_index_path(state: &AppState, kb_id: &str) -> std::path::PathBuf {
    state.kb_index_dir.read().join(format!("{}.usearch", kb_id))
}

fn normalize_option_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn option_to_json(value: Option<String>) -> serde_json::Value {
    match value {
        Some(v) => serde_json::json!(v),
        None => serde_json::Value::Null,
    }
}

#[tauri::command]
pub fn create_kb(
    state: State<AppState>,
    name: String,
    description: Option<String>,
    embedding_channel_id: Option<String>,
    embedding_model: String,
) -> Result<KnowledgeBase, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("knowledge base name must not be empty".to_string());
    }
    if state
        .repo
        .get_kb_by_name(&name)
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err(format!("knowledge base '{}' already exists", name));
    }

    // 建空 usearch 索引目录；索引文件在首次检索/摄取时按需创建。
    let index_dir = state.kb_index_dir.read().clone();
    std::fs::create_dir_all(&index_dir)
        .map_err(|e| format!("failed to create kb index dir: {e}"))?;

    let now = chrono::Utc::now().timestamp();
    let kb = KnowledgeBase {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description,
        embedding_channel_id,
        embedding_model,
        dim: 0,
        doc_count: 0,
        chunk_count: 0,
        enabled: true,
        created_at: now,
        updated_at: now,
        needs_reindex: false,
    };
    state.repo.create_kb(&kb).map_err(|e| e.to_string())?;
    Ok(kb)
}

fn list_kbs_with_state(state: &AppState) -> Result<Vec<KnowledgeBase>, String> {
    let mut kbs = state.repo.list_kbs().map_err(|e| e.to_string())?;
    for kb in &mut kbs {
        let index_path = kb_index_path(state, &kb.id);
        kb.needs_reindex = kb.chunk_count > 0 && !index_path.exists();
    }
    Ok(kbs)
}

#[tauri::command]
pub fn list_kbs(state: State<AppState>) -> Result<Vec<KnowledgeBase>, String> {
    list_kbs_with_state(&state)
}

#[tauri::command]
pub fn delete_kb(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_kb(&id).map_err(|e| e.to_string())?;
    // 删索引文件为尽力而为：失败仅记录，不阻断删除结果。
    let index_path = kb_index_path(&state, &id);
    if let Err(e) = std::fs::remove_file(&index_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::error!(
                "failed to delete kb index file {}: {}",
                index_path.display(),
                e
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn reindex_kb(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state
        .repo
        .get_kb(&id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("knowledge base not found: {id}"));
    }
    // 后台重建：从 kb_chunks.content 重新 embedding 并重写 usearch 索引。
    // 立即返回 Ok,不阻塞 UI;失败在任务内 log::error!（同 upload_document 的异步模式）。
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            crate::knowledge::ingest::reindex_kb_contents(state.clone(), id.clone()).await
        {
            log::error!("kb reindex failed for {}: {}", id, e);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn upload_document(
    state: State<AppState>,
    kb_id: String,
    filename: String,
    content_base64: String,
) -> Result<KbDocument, String> {
    if state
        .repo
        .get_kb(&kb_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("knowledge base not found: {kb_id}"));
    }
    // 先解码校验；不合法直接 Err。
    let content = decode_base64(&content_base64)?;
    let file_type = file_type_str(&filename).to_string();
    let doc = KbDocument {
        id: uuid::Uuid::new_v4().to_string(),
        kb_id,
        filename,
        file_type,
        size_bytes: content.len() as i64,
        chunk_count: 0,
        status: "indexing".to_string(),
        error: None,
        created_at: chrono::Utc::now().timestamp(),
    };
    state.repo.insert_document(&doc).map_err(|e| e.to_string())?;
    // 暂存解码后的原始内容,供异步摄取任务按 doc_id 读取(KbDocument 不含 content 字段)。
    if let Err(e) = crate::knowledge::ingest::stage_content(&state, &doc.id, &content) {
        let _ = state.repo.update_document_status(&doc.id, "failed", Some(&e));
        return Err(e);
    }
    crate::knowledge::ingest::spawn_ingest(state.inner().clone(), doc.id.clone());
    Ok(doc)
}

#[tauri::command]
pub fn list_documents(state: State<AppState>, kb_id: String) -> Result<Vec<KbDocument>, String> {
    state.repo.list_documents(&kb_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_document(state: State<AppState>, id: String) -> Result<(), String> {
    let doc = state
        .repo
        .get_document(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("document not found: {id}"))?;
    let kb_id = doc.kb_id.clone();
    let embedding_ids: Vec<u64> = state
        .repo
        .list_chunks(&kb_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|c| c.doc_id == id)
        .map(|c| c.embedding_id as u64)
        .collect();

    // 从向量索引移除该文档的 embedding（尽力而为，失败不阻断级联删除）。
    if !embedding_ids.is_empty() {
        let index_path = kb_index_path(&state, &kb_id);
        if index_path.exists() {
            let dim = state
                .repo
                .get_kb(&kb_id)
                .map_err(|e| e.to_string())?
                .map(|kb| (kb.dim as usize).max(1))
                .unwrap_or(1);
            match VectorIndex::open_or_create(&index_path, dim) {
                Ok(index) => {
                    for eid in &embedding_ids {
                        if let Err(e) = index.remove(*eid) {
                            log::warn!(
                                "failed to remove embedding {} from index {}: {}",
                                eid,
                                index_path.display(),
                                e
                            );
                        }
                    }
                    if let Err(e) = index.save() {
                        log::warn!(
                            "failed to save index {} after removing document: {}",
                            index_path.display(),
                            e
                        );
                    }
                }
                Err(e) => log::warn!(
                    "failed to open index {} for document removal: {}",
                    index_path.display(),
                    e
                ),
            }
        }
    }

    state.repo.delete_document(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_kb(
    state: State<'_, AppState>,
    kb_id: String,
    query: String,
) -> Result<Vec<RetrievedChunk>, String> {
    let kb = state
        .repo
        .get_kb(&kb_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("knowledge base not found: {kb_id}"))?;
    retrieve(&state, &kb, &query, SEARCH_TOP_N).await
}

#[tauri::command]
pub fn get_rag_settings(state: State<AppState>) -> Result<RagSettings, String> {
    Ok(state.rag.read().clone())
}

#[tauri::command]
pub fn set_rag_setting(
    app: tauri::AppHandle,
    state: State<AppState>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let store_value: serde_json::Value = {
        let mut settings = state.rag.write();
        match key.as_str() {
            "enabled" => {
                let enabled = value
                    .as_bool()
                    .ok_or_else(|| format!("rag.{} must be a boolean", key))?;
                settings.enabled = enabled;
                serde_json::json!(enabled)
            }
            "default_kb" => {
                let v = normalize_option_string(&value);
                settings.default_kb = v.clone();
                option_to_json(v)
            }
            "default_embedding_channel" => {
                let v = normalize_option_string(&value);
                settings.default_embedding_channel = v.clone();
                option_to_json(v)
            }
            _ => return Err(format!("unknown rag setting: {}", key)),
        }
    };

    if let Ok(store) = app.store("store.bin") {
        let _ = store.set(format!("rag.{}", key), store_value);
        if let Err(e) = store.save() {
            log::error!("failed to save rag store: {}", e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::path::PathBuf;

    fn kb_with_chunks(id: &str, chunk_count: i64) -> KnowledgeBase {
        KnowledgeBase {
            id: id.into(),
            name: format!("kb-{id}"),
            description: None,
            embedding_channel_id: None,
            embedding_model: "text-embedding-3-small".into(),
            dim: 0,
            doc_count: if chunk_count > 0 { 1 } else { 0 },
            chunk_count,
            enabled: true,
            created_at: 1,
            updated_at: 1,
            needs_reindex: false,
        }
    }

    fn temp_index_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("llm-gateway")
            .join("kb")
            .join(format!("list_kbs_{}_{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_kbs_needs_reindex_when_chunks_without_index() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        *state.kb_index_dir.write() = temp_index_dir("missing");

        state.repo.create_kb(&kb_with_chunks("kb1", 5)).unwrap();
        let kbs = list_kbs_with_state(&state).unwrap();
        assert_eq!(kbs.len(), 1);
        assert!(
            kbs[0].needs_reindex,
            "chunks without index file should need reindex"
        );
    }

    #[test]
    fn list_kbs_no_reindex_when_index_exists() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        let dir = temp_index_dir("exists");
        *state.kb_index_dir.write() = dir.clone();

        state.repo.create_kb(&kb_with_chunks("kb1", 5)).unwrap();
        // 任意文件即可模拟索引文件存在(计算仅校验存在性)
        std::fs::write(dir.join("kb1.usearch"), b"").unwrap();

        let kbs = list_kbs_with_state(&state).unwrap();
        assert!(
            !kbs[0].needs_reindex,
            "existing index file should not need reindex"
        );
    }

    #[test]
    fn list_kbs_no_reindex_when_no_chunks() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        *state.kb_index_dir.write() = temp_index_dir("empty");

        state.repo.create_kb(&kb_with_chunks("kb1", 0)).unwrap();
        let kbs = list_kbs_with_state(&state).unwrap();
        assert!(
            !kbs[0].needs_reindex,
            "empty kb should never need reindex"
        );
    }
}
