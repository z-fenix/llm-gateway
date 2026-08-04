/// 命中映射返回 target，否则原样返回 request_model。
pub fn resolve_model(maps: &[(String, String)], request_model: &str) -> String {
    for (src, tgt) in maps {
        if src == request_model {
            return tgt.clone();
        }
    }
    request_model.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::repository::Repository;
    use crate::db::Db;
    use crate::router::dispatch::tests_helper_channel;

    #[test]
    fn resolve_hit_and_miss() {
        let maps = vec![
            ("gpt-4o".to_string(), "gpt-4o-2024-08-06".to_string()),
        ];
        assert_eq!(resolve_model(&maps, "gpt-4o"), "gpt-4o-2024-08-06");
        assert_eq!(resolve_model(&maps, "gpt-4o-mini"), "gpt-4o-mini");
    }

    #[test]
    fn model_map_crud_and_resolve() {
        let repo = Repository::new(Db::new_in_memory().unwrap());
        let ch = tests_helper_channel("c1");
        repo.insert_channel(&ch).unwrap();
        repo.set_model_map("c1", "claude-sonnet-4", "deepseek-v4-flash").unwrap();
        // 覆盖更新
        repo.set_model_map("c1", "claude-sonnet-4", "deepseek-v4-flash-0715").unwrap();
        let maps = repo.get_model_map("c1").unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(resolve_model(&maps, "claude-sonnet-4"), "deepseek-v4-flash-0715");
    }
}
