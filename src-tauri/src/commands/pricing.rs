use crate::db::models::ModelPrice;
use crate::proxy::state::AppState;
use tauri::State;

/// 归一化模型名，用于查价与落库 `pricing_model`：
/// 小写/trim、去 provider 前缀（第一个 `/` 之前）、去 `:` 后缀、`@`→`-`。
/// 对齐 cc-switch 的 clean_model_id_for_pricing（此处按需求用第一个 `/` 去前缀）。
pub fn normalize_model(id: &str) -> String {
    let lower = id.trim().to_ascii_lowercase();
    let after_slash = lower.split_once('/').map(|(_, r)| r).unwrap_or(&lower);
    let after_colon = after_slash.split(':').next().unwrap_or(after_slash);
    after_colon.trim().replace('@', "-")
}

#[tauri::command]
pub fn list_model_prices(state: State<AppState>) -> Result<Vec<ModelPrice>, String> {
    state.repo.list_model_prices().map_err(|e| e.to_string())
}

/// upsert 定价成功后 backfill 重算受影响行成本；返回受影响行数（无受影响行返回 None）。
#[tauri::command]
pub fn upsert_model_price(
    state: State<AppState>,
    price: ModelPrice,
) -> Result<Option<usize>, String> {
    state
        .repo
        .upsert_model_price(&price)
        .map_err(|e| e.to_string())?;
    let affected = state
        .repo
        .recompute_cost_for_model(&price.model_id)
        .map_err(|e| e.to_string())?;
    Ok(if affected > 0 { Some(affected) } else { None })
}

/// 删除定价成功后 backfill 重算（无价格 → 成本归 0）；返回受影响行数（无受影响行返回 None）。
#[tauri::command]
pub fn delete_model_price(
    state: State<AppState>,
    model_id: String,
) -> Result<Option<usize>, String> {
    state
        .repo
        .delete_model_price(&model_id)
        .map_err(|e| e.to_string())?;
    let affected = state
        .repo
        .recompute_cost_for_model(&model_id)
        .map_err(|e| e.to_string())?;
    Ok(if affected > 0 { Some(affected) } else { None })
}

#[cfg(test)]
mod tests {
    use super::normalize_model;

    #[test]
    fn normalize_lowercases_and_trims() {
        assert_eq!(normalize_model("Claude-Sonnet-4.5"), "claude-sonnet-4.5");
        assert_eq!(normalize_model("  Gpt-4o  "), "gpt-4o");
    }

    #[test]
    fn normalize_strips_provider_prefix_before_first_slash() {
        // 去第一个 `/` 之前的部分，保留其余命名空间
        assert_eq!(
            normalize_model("openrouter/anthropic/claude-sonnet-4.5:free"),
            "anthropic/claude-sonnet-4.5"
        );
        assert_eq!(
            normalize_model("azure/deployment/gpt-4o"),
            "deployment/gpt-4o"
        );
        assert_eq!(
            normalize_model("models/gemini-2.0-flash"),
            "gemini-2.0-flash"
        );
    }

    #[test]
    fn normalize_strips_colon_suffix() {
        assert_eq!(
            normalize_model("claude-sonnet-4.5:free"),
            "claude-sonnet-4.5"
        );
        assert_eq!(normalize_model("gpt-4o:beta"), "gpt-4o");
    }

    #[test]
    fn normalize_replaces_at_with_dash() {
        assert_eq!(normalize_model("gpt-4o@2024-05-13"), "gpt-4o-2024-05-13");
    }

    #[test]
    fn normalize_empty_stays_empty() {
        assert_eq!(normalize_model(""), "");
        assert_eq!(normalize_model("   "), "");
    }
}
