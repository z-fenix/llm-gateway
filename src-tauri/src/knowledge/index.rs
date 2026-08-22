//! 知识库向量索引封装。
//!
//! 基于 `usearch` HNSW 实现，提供可持久化的 embedding 增删改查能力。
//! 索引文件路径为 `<data_dir>/kb/<kb_id>.usearch`，使用 Cos 相似度 + F32 量化。

use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

const INITIAL_CAPACITY: usize = 1024;

/// 基于 usearch 的持久化向量索引。
pub struct VectorIndex {
    index: Mutex<Index>,
    path: PathBuf,
    dim: usize,
    capacity: AtomicUsize,
}

impl VectorIndex {
    fn options(dim: usize) -> IndexOptions {
        IndexOptions {
            dimensions: dim,
            metric: MetricKind::Cos,
            quantization: ScalarKind::F32,
            connectivity: 16,
            expansion_add: 40,
            expansion_search: 20,
            ..Default::default()
        }
    }

    fn path_str(path: &Path) -> Result<&str, String> {
        path.to_str()
            .ok_or_else(|| "invalid index path".to_string())
    }

    /// 新建一个空的向量索引文件（尚未落盘，可随后调用 `save`）。
    pub fn create(path: &Path, dim: usize) -> Result<Self, String> {
        let options = Self::options(dim);
        let index = Index::new(&options).map_err(|_| "failed to create vector index")?;
        index
            .reserve(INITIAL_CAPACITY)
            .map_err(|_| "failed to reserve index capacity")?;
        Ok(Self {
            index: Mutex::new(index),
            path: path.to_path_buf(),
            dim,
            capacity: AtomicUsize::new(INITIAL_CAPACITY),
        })
    }

    /// 若索引文件已存在则加载，否则新建一个空索引。
    pub fn open_or_create(path: &Path, dim: usize) -> Result<Self, String> {
        let path_str = Self::path_str(path)?;
        if path.exists() {
            match Index::restore(path_str) {
                Ok(index) => {
                    let size = index.size();
                    return Ok(Self {
                        index: Mutex::new(index),
                        path: path.to_path_buf(),
                        dim,
                        capacity: AtomicUsize::new(size.max(1)),
                    });
                }
                Err(_) => {
                    // 损坏或不可读时回退到新建，后续 save 会覆盖原文件。
                }
            }
        }
        Self::create(path, dim)
    }

    fn ensure_capacity(&self, index: &mut usearch::Index) -> Result<(), String> {
        let size = index.size();
        let current = self.capacity.load(Ordering::Relaxed);
        if size >= current {
            let new_cap = current.saturating_mul(2).max(INITIAL_CAPACITY);
            index
                .reserve(new_cap)
                .map_err(|_| "failed to expand index capacity")?;
            self.capacity.store(new_cap, Ordering::Relaxed);
        }
        Ok(())
    }

    /// 添加或更新一个 embedding 向量。
    pub fn add(&self, embedding_id: u64, vec: &[f32]) -> Result<(), String> {
        if vec.len() != self.dim {
            return Err("vector dimension mismatch".to_string());
        }
        let mut index = self.index.lock();
        self.ensure_capacity(&mut index)?;
        index
            .add(embedding_id, vec)
            .map_err(|_| "failed to add vector to index")?;
        Ok(())
    }

    /// 搜索与 query 最接近的 `top_k` 个向量，返回 `(embedding_id, distance)`。
    pub fn search(&self, vec: &[f32], top_k: usize) -> Result<Vec<(u64, f32)>, String> {
        if vec.len() != self.dim {
            return Err("vector dimension mismatch".to_string());
        }
        let index = self.index.lock();
        let matches = index
            .search(vec, top_k)
            .map_err(|_| "failed to search index")?;
        Ok(matches
            .keys
            .into_iter()
            .zip(matches.distances.into_iter())
            .collect())
    }

    /// 从索引中移除指定 embedding。
    pub fn remove(&self, embedding_id: u64) -> Result<(), String> {
        let index = self.index.lock();
        let removed = index
            .remove(embedding_id)
            .map_err(|_| "failed to remove vector from index")?;
        if removed == 0 {
            return Err("embedding not found in index".to_string());
        }
        Ok(())
    }

    /// 将索引持久化到磁盘。
    pub fn save(&self) -> Result<(), String> {
        let index = self.index.lock();
        let path_str = Self::path_str(&self.path)?;
        index.save(path_str).map_err(|_| "failed to save index")?;
        Ok(())
    }

    /// 检查现有索引文件是否需要重建（维度/量化/度量不一致或文件损坏）。
    pub fn needs_reindex(path: &Path, expected_dim: usize) -> bool {
        if !path.exists() {
            return false;
        }
        let Some(path_str) = path.to_str() else {
            return true;
        };
        match Index::metadata(path_str) {
            Ok(meta) => {
                meta.dimensions as usize != expected_dim
                    || meta.metric != MetricKind::Cos
                    || meta.quantization != ScalarKind::F32
            }
            Err(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;
    use std::fs;

    fn test_path(name: &str) -> PathBuf {
        let path = temp_dir().join(format!("llm_gateway_index_{}.usearch", name));
        let _ = fs::remove_file(&path);
        path
    }

    fn assert_approx_eq(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "expected {} ~= {}", a, b);
    }

    #[test]
    fn index_add_search_returns_nearest() {
        let path = test_path("add_search");
        let index = VectorIndex::create(&path, 4).unwrap();
        index.add(10, &[1.0_f32, 0.0, 0.0, 0.0]).unwrap();
        index.add(20, &[0.0_f32, 1.0, 0.0, 0.0]).unwrap();
        index.add(30, &[0.0_f32, 0.0, 1.0, 0.0]).unwrap();

        let results = index.search(&[1.0_f32, 0.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 10);
        assert_approx_eq(results[0].1, 0.0);
    }

    #[test]
    fn index_persists_save_and_load() {
        let path = test_path("persist");
        {
            let index = VectorIndex::create(&path, 4).unwrap();
            index.add(1, &[1.0_f32, 0.0, 0.0, 0.0]).unwrap();
            index.add(2, &[0.0_f32, 1.0, 0.0, 0.0]).unwrap();
            index.save().unwrap();
        }

        let loaded = VectorIndex::open_or_create(&path, 4).unwrap();
        let results = loaded.search(&[1.0_f32, 0.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 1);
        assert_approx_eq(results[0].1, 0.0);
    }

    #[test]
    fn index_remove_excludes_key() {
        let path = test_path("remove");
        let index = VectorIndex::create(&path, 4).unwrap();
        index.add(1, &[1.0_f32, 0.0, 0.0, 0.0]).unwrap();
        index.add(2, &[0.0_f32, 1.0, 0.0, 0.0]).unwrap();
        index.add(3, &[0.0_f32, 0.0, 1.0, 0.0]).unwrap();

        index.remove(2).unwrap();

        let results = index.search(&[0.0_f32, 1.0, 0.0, 0.0], 3).unwrap();
        assert!(
            results.iter().all(|(id, _)| *id != 2),
            "removed embedding 2 should not appear in search results"
        );
    }
}
