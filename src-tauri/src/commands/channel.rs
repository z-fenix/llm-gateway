use crate::db::models::{Channel, ModelMapEntry};
use crate::proxy::state::AppState;
use serde::Serialize;
use tauri::State;

fn mask(key: &str) -> String {
    if key.len() <= 4 {
        return "****".into();
    }
    format!("sk-***{}", &key[key.len() - 4..])
}

#[derive(Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: i64,
    pub error: Option<String>,
}

#[tauri::command]
pub fn list_channels(state: State<AppState>) -> Result<Vec<Channel>, String> {
    let mut cs = state.repo.list_channels().map_err(|e| e.to_string())?;
    for c in &mut cs {
        c.api_key = mask(&c.api_key);
    }
    Ok(cs)
}

/// 渠道表单校验（前端与后端同一套规则，后端为准）。
/// 校验 name 非空、base_url 为 http/https、api_key 非空、models 至少 1 个且每一项 trim 后非空、timeout_secs ≥ 1。
fn validate_channel(c: &Channel) -> Result<(), String> {
    if c.name.trim().is_empty() {
        return Err("渠道名称不能为空".into());
    }
    let base_url = c.base_url.trim();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".into());
    }
    match reqwest::Url::parse(base_url) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => {}
        _ => return Err("Base URL 必须是有效的 http/https 地址".into()),
    }
    if c.api_key.trim().is_empty() {
        return Err("API Key 不能为空".into());
    }
    if c.models.is_empty() || c.models.iter().any(|m| m.trim().is_empty()) {
        return Err("至少需要一个模型".into());
    }
    if c.timeout_secs < 1 {
        return Err("超时时间必须大于等于 1 秒".into());
    }
    Ok(())
}

#[tauri::command]
pub fn create_channel(state: State<AppState>, c: Channel) -> Result<Channel, String> {
    create_channel_with_state(&state, c)
}

fn create_channel_with_state(state: &AppState, mut c: Channel) -> Result<Channel, String> {
    validate_channel(&c)?;
    // 校验通过后归一化：去除 name / base_url 首尾空白，避免带空格的值在 reqwest 解析时失败
    c.name = c.name.trim().to_string();
    c.base_url = c.base_url.trim().to_string();
    c.id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    c.created_at = now;
    c.updated_at = now;
    state.repo.insert_channel(&c).map_err(|e| e.to_string())?;
    let mut out = c.clone();
    out.api_key = mask(&out.api_key);
    Ok(out)
}

#[tauri::command]
pub fn update_channel(state: State<AppState>, c: Channel) -> Result<(), String> {
    update_channel_with_state(&state, c)
}

fn update_channel_with_state(state: &AppState, mut c: Channel) -> Result<(), String> {
    c.updated_at = chrono::Utc::now().timestamp();
    // api_key 若是打码形式（长 key 为 sk-***xxxx，短 key 为 ****）则不更新（保留原值）
    if c.api_key.starts_with("sk-***") || c.api_key == "****" {
        if let Some(orig) = state.repo.get_channel(&c.id).map_err(|e| e.to_string())? {
            c.api_key = orig.api_key;
        }
    }
    // 在还原打码 api_key 之后再校验最终生效值，保证编辑时保留原 key 也能通过
    validate_channel(&c)?;
    // 校验通过后归一化：去除 name / base_url 首尾空白
    c.name = c.name.trim().to_string();
    c.base_url = c.base_url.trim().to_string();
    state.repo.update_channel(&c).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_channel(state: State<AppState>, id: String) -> Result<(), String> {
    state.repo.delete_channel(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_channel(state: State<'_, AppState>, id: String) -> Result<TestResult, String> {
    let ch = state
        .repo
        .get_channel(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "channel not found".to_string())?;
    // 密钥为空通常是主密钥变更后旧密文无法解密（dec 解密失败返回空串）；
    // 保存时已强制 api_key 非空，因此空值必为解密失败，给出可操作的报错而非发给上游 401。
    if ch.api_key.is_empty() {
        return Ok(TestResult {
            ok: false,
            latency_ms: 0,
            error: Some("渠道密钥为空（解密失败），请在编辑中重新填写 API Key".into()),
        });
    }
    let model = ch.models.get(0).cloned().unwrap_or("test".into());
    let url = crate::provider::adapter::upstream_url(
        &ch.upstream_protocol,
        &ch.base_url,
        &model,
        &ch.api_key,
        false,
    );
    let mut req = state
        .http
        .post(&url)
        .header("content-type", "application/json")
        .timeout(std::time::Duration::from_secs(ch.timeout_secs as u64));
    if let Some((hname, hval)) =
        crate::provider::adapter::auth_header(&ch.upstream_protocol, &ch.api_key)
    {
        req = req.header(hname, hval);
    }
    let chat = crate::protocol::types::ChatRequest {
        model: model.clone(),
        messages: vec![crate::protocol::types::ChatMessage {
            role: "user".into(),
            content: serde_json::json!("ping"),
        }],
        max_tokens: Some(1),
        stream: false,
        temperature: None,
        tools: None,
        extra: Default::default(),
    };
    let body = crate::provider::adapter::build_upstream_body(&chat, &ch.upstream_protocol, &model);
    let start = std::time::Instant::now();
    let resp = req.json(&body).send().await;
    let latency = start.elapsed().as_millis() as i64;
    match resp {
        Ok(r) if r.status().is_success() => Ok(TestResult {
            ok: true,
            latency_ms: latency,
            error: None,
        }),
        Ok(r) => Ok(TestResult {
            ok: false,
            latency_ms: latency,
            error: Some(format!("status {}", r.status())),
        }),
        Err(e) => Ok(TestResult {
            ok: false,
            latency_ms: latency,
            error: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
pub fn duplicate_channel(state: State<AppState>, id: String) -> Result<Channel, String> {
    let mut c = state
        .repo
        .get_channel(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "channel not found".to_string())?;
    c.id = uuid::Uuid::new_v4().to_string();
    c.name = format!("{} (副本)", c.name);
    let now = chrono::Utc::now().timestamp();
    c.created_at = now;
    c.updated_at = now;
    c.total_calls = 0;
    c.total_tokens = 0;
    c.success_rate = 1.0;
    c.avg_latency_ms = 0;
    state.repo.insert_channel(&c).map_err(|e| e.to_string())?;
    c.api_key = mask(&c.api_key);
    Ok(c)
}

#[tauri::command]
pub fn set_model_map(
    state: State<AppState>,
    channel_id: String,
    source_model: String,
    target_model: String,
) -> Result<(), String> {
    set_model_map_with_state(&state, channel_id, source_model, target_model)
}

fn set_model_map_with_state(
    state: &AppState,
    channel_id: String,
    source_model: String,
    target_model: String,
) -> Result<(), String> {
    if source_model.trim().is_empty() || target_model.trim().is_empty() {
        return Err("源模型与目标模型不能为空".into());
    }
    state
        .repo
        .set_model_map(&channel_id, &source_model, &target_model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_model_map(
    state: State<AppState>,
    channel_id: String,
    source_model: String,
) -> Result<(), String> {
    delete_model_map_with_state(&state, channel_id, source_model)
}

fn delete_model_map_with_state(
    state: &AppState,
    channel_id: String,
    source_model: String,
) -> Result<(), String> {
    state
        .repo
        .delete_model_map(&channel_id, &source_model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_model_map(
    state: State<AppState>,
    channel_id: String,
) -> Result<Vec<ModelMapEntry>, String> {
    get_model_map_with_state(&state, channel_id)
}

fn get_model_map_with_state(
    state: &AppState,
    channel_id: String,
) -> Result<Vec<ModelMapEntry>, String> {
    state
        .repo
        .get_model_map(&channel_id)
        .map_err(|e| e.to_string())
        .map(|pairs| {
            pairs
                .into_iter()
                .map(|(source_model, target_model)| ModelMapEntry {
                    channel_id: channel_id.clone(),
                    source_model,
                    target_model,
                })
                .collect()
        })
}

/// 解析上游模型列表响应：
/// - OpenAI 兼容：`{ "object":"list", "data":[ { "id": "gpt-4o" } ] }`
/// - Gemini Native：`{ "models":[ { "name": "models/gemini-2.5-pro" } ] }`（去掉 `models/` 前缀）
fn parse_models_response(protocol: &str, bytes: &[u8]) -> Result<Vec<String>, String> {
    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("模型列表响应解析失败: {e}"))?;
    let mut out: Vec<String> = vec![];
    if protocol == "gemini-native" {
        if let Some(arr) = v["models"].as_array() {
            for m in arr {
                if let Some(name) = m["name"].as_str() {
                    out.push(name.trim_start_matches("models/").to_string());
                }
            }
        }
        return Ok(out);
    }
    if let Some(arr) = v["data"].as_array() {
        for m in arr {
            if let Some(id) = m["id"].as_str() {
                out.push(id.to_string());
            }
        }
    }
    Ok(out)
}

/// 拉取上游渠道的模型列表（`GET {base_url}/v1/models`）。
/// 用于渠道表单里“列出支持模型，可选择”。失败时前端回退到内置的供应商静态清单。
#[tauri::command]
pub async fn list_channel_models(
    state: State<'_, AppState>,
    base_url: String,
    upstream_protocol: String,
    api_key: String,
    timeout_secs: i64,
    channel_id: Option<String>,
) -> Result<Vec<String>, String> {
    list_channel_models_with_state(
        &state,
        base_url,
        upstream_protocol,
        api_key,
        timeout_secs,
        channel_id,
    )
    .await
}

async fn list_channel_models_with_state(
    state: &AppState,
    base_url: String,
    upstream_protocol: String,
    api_key: String,
    timeout_secs: i64,
    channel_id: Option<String>,
) -> Result<Vec<String>, String> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("Base URL 不能为空".into());
    }
    // 编辑模式下表单里是打码 key（sk-***xxxx / ****），需要用渠道 id 从库里取真实 key。
    // 新建模式下用户直接填真实 key，无需查库。
    let api_key = if api_key.starts_with("sk-***") || api_key == "****" {
        if let Some(id) = &channel_id {
            state
                .repo
                .get_channel(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "渠道不存在".to_string())?
                .api_key
        } else {
            return Err("编辑模式请先保存渠道或重新填写 API Key".into());
        }
    } else {
        api_key
    };
    if api_key.is_empty() {
        return Err("渠道密钥为空（解密失败），请在编辑中重新填写 API Key".into());
    }
    // Anthropic 无公开的“列模型”GET 接口，返回空让前端走静态清单。
    if upstream_protocol == "anthropic-messages" {
        return Ok(vec![]);
    }
    let url = crate::provider::adapter::models_url(&upstream_protocol, &base_url, &api_key);
    let timeout = if timeout_secs < 1 { 60usize } else { timeout_secs as usize };
    let mut req = state
        .http
        .get(&url)
        .timeout(std::time::Duration::from_secs(timeout as u64));
    if let Some((hname, hval)) =
        crate::provider::adapter::auth_header(&upstream_protocol, &api_key)
    {
        req = req.header(hname, hval);
    }
    let resp = req.send().await.map_err(|e| format!("请求上游失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上游返回状态码 {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取上游响应失败: {e}"))?;
    parse_models_response(&upstream_protocol, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn test_channel(id: &str) -> Channel {
        Channel {
            id: id.into(),
            name: "test".into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
            base_url: "https://api.openai.com".into(),
            api_key: "sk-test".into(),
            models: vec!["gpt-4o".into()],
            priority: 0,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn model_map_set_get_delete_roundtrip() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        set_model_map_with_state(
            &state,
            "ch1".into(),
            "gpt-4o".into(),
            "gpt-4o-2024-08-06".into(),
        )
        .unwrap();
        set_model_map_with_state(
            &state,
            "ch1".into(),
            "claude-sonnet".into(),
            "claude-3-5-sonnet".into(),
        )
        .unwrap();

        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 2);
        let mut by_source: std::collections::HashMap<&str, &str> = maps
            .iter()
            .map(|m| (m.source_model.as_str(), m.target_model.as_str()))
            .collect();
        assert_eq!(by_source.remove("gpt-4o"), Some("gpt-4o-2024-08-06"));
        assert_eq!(by_source.remove("claude-sonnet"), Some("claude-3-5-sonnet"));
        assert!(by_source.is_empty());
        assert!(maps.iter().all(|m| m.channel_id == "ch1"));

        delete_model_map_with_state(&state, "ch1".into(), "gpt-4o".into()).unwrap();
        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].source_model, "claude-sonnet");
    }

    #[test]
    fn model_map_overwrite_updates_target() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        set_model_map_with_state(
            &state,
            "ch1".into(),
            "gpt-4o".into(),
            "gpt-4o-2024-05".into(),
        )
        .unwrap();
        set_model_map_with_state(
            &state,
            "ch1".into(),
            "gpt-4o".into(),
            "gpt-4o-2024-08-06".into(),
        )
        .unwrap();

        let maps = get_model_map_with_state(&state, "ch1".into()).unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].target_model, "gpt-4o-2024-08-06");
    }

    #[test]
    fn model_map_empty_model_rejected() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        let err =
            set_model_map_with_state(&state, "ch1".into(), "".into(), "gpt-4o".into()).unwrap_err();
        assert_eq!(err, "源模型与目标模型不能为空");

        let err = set_model_map_with_state(&state, "ch1".into(), "gpt-4o".into(), "   ".into())
            .unwrap_err();
        assert_eq!(err, "源模型与目标模型不能为空");
    }

    #[test]
    fn validate_blank_name_rejected() {
        let mut c = test_channel("ch1");
        c.name = "   ".into();
        assert_eq!(validate_channel(&c), Err("渠道名称不能为空".into()));
    }

    #[test]
    fn validate_invalid_base_url_rejected() {
        for bad in [
            "",
            "   ",
            "not-a-url",
            "ftp://example.com",
            "javascript:alert(1)",
        ] {
            let mut c = test_channel("ch1");
            c.base_url = bad.into();
            assert!(validate_channel(&c).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn validate_missing_api_key_rejected() {
        let mut c = test_channel("ch1");
        c.api_key = "   ".into();
        assert_eq!(validate_channel(&c), Err("API Key 不能为空".into()));
    }

    #[test]
    fn validate_empty_models_rejected() {
        let mut c = test_channel("ch1");
        c.models = vec![];
        assert!(validate_channel(&c).is_err());
        c.models = vec!["   ".into()];
        assert!(validate_channel(&c).is_err());
    }

    #[test]
    fn validate_whitespace_model_entry_rejected() {
        // 只要有一项 trim 后为空就拒绝，避免空白模型泄漏进 /v1/models 响应
        let mut c = test_channel("ch1");
        c.models = vec!["gpt-4o".into(), "   ".into()];
        assert_eq!(validate_channel(&c), Err("至少需要一个模型".into()));
        c.models = vec![" gpt-4o ".into(), "\t".into()];
        assert_eq!(validate_channel(&c), Err("至少需要一个模型".into()));
        // 正常多模型通过
        c.models = vec!["gpt-4o".into(), "claude-sonnet".into()];
        assert!(validate_channel(&c).is_ok());
    }

    #[test]
    fn validate_timeout_below_1_rejected() {
        let mut c = test_channel("ch1");
        c.timeout_secs = 0;
        assert!(validate_channel(&c).is_err());
        c.timeout_secs = -5;
        assert!(validate_channel(&c).is_err());
    }

    #[test]
    fn parse_models_response_openai_list() {
        let body = br#"{"object":"list","data":[{"id":"gpt-4o"},{"id":"deepseek-chat"}]}"#;
        assert_eq!(
            parse_models_response("openai-chat", body).unwrap(),
            vec!["gpt-4o", "deepseek-chat"]
        );
    }

    #[test]
    fn parse_models_response_gemini_strips_models_prefix() {
        let body = br#"{"models":[{"name":"models/gemini-2.5-pro"},{"name":"models/gemini-2.5-flash"}]}"#;
        assert_eq!(
            parse_models_response("gemini-native", body).unwrap(),
            vec!["gemini-2.5-pro", "gemini-2.5-flash"]
        );
    }

    #[test]
    fn parse_models_response_empty_ok() {
        assert_eq!(
            parse_models_response("openai-chat", br#"{"object":"list","data":[]}"#).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(parse_models_response("gemini-native", br#"{"models":[]}"#).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn parse_models_response_invalid_json_errors() {
        assert!(parse_models_response("openai-chat", br#"not-json"#).is_err());
    }

    /// 起一个返回固定体的 mock GET /v1/models 上游，返回 base_url。
    async fn spawn_models_mock(body: serde_json::Value) -> String {
        let app = axum::Router::new().route(
            "/v1/models",
            axum::routing::get(move || {
                let b = body.clone();
                async move { axum::Json(b) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{}", addr)
    }

    #[tokio::test]
    async fn list_channel_models_fetches_upstream_models() {
        let base = spawn_models_mock(serde_json::json!({
            "object": "list",
            "data": [{"id": "gpt-4o"}, {"id": "deepseek-chat"}]
        }))
        .await;
        let state = AppState::new(Db::new_in_memory().unwrap());
        let models = list_channel_models_with_state(
            &state,
            base,
            "openai-chat".into(),
            "sk-test".into(),
            10,
            None,
        )
        .await
        .unwrap();
        assert_eq!(models, vec!["gpt-4o", "deepseek-chat"]);
    }

    #[tokio::test]
    async fn list_channel_models_anthropic_returns_empty() {
        let state = AppState::new(Db::new_in_memory().unwrap());
        let models = list_channel_models_with_state(
            &state,
            "https://api.anthropic.com".into(),
            "anthropic-messages".into(),
            "sk-ant-test".into(),
            10,
            None,
        )
        .await
        .unwrap();
        assert!(models.is_empty());
    }

    #[tokio::test]
    async fn list_channel_models_unreachable_errors() {
        let state = AppState::new(Db::new_in_memory().unwrap());
        let res = list_channel_models_with_state(
            &state,
            "http://127.0.0.1:1".into(), // 无监听端口
            "openai-chat".into(),
            "sk-test".into(),
            1,
            None,
        )
        .await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn list_channel_models_masked_key_uses_db_key() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap(); // api_key = "sk-test"
        let base = spawn_models_mock(serde_json::json!({
            "object": "list",
            "data": [{"id": "gpt-4o"}]
        }))
        .await;
        // 编辑表单把 key 打码后回传，应取库里的真实 key（"sk-test"）去请求
        let models = list_channel_models_with_state(
            &state,
            base,
            "openai-chat".into(),
            "sk-***test".into(),
            10,
            Some("ch1".into()),
        )
        .await
        .unwrap();
        assert_eq!(models, vec!["gpt-4o"]);
    }

    #[test]
    fn validate_valid_channel_passes() {
        assert!(validate_channel(&test_channel("ch1")).is_ok());
        // 最小合法值：timeout=1、http URL 也应通过
        let mut c = test_channel("ch1");
        c.timeout_secs = 1;
        c.base_url = "http://localhost:8000".into();
        assert!(validate_channel(&c).is_ok());
    }

    #[test]
    fn create_channel_rejects_invalid_and_inserts_valid() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        let mut invalid = test_channel("id-ignored");
        invalid.name = "".into();
        assert!(create_channel_with_state(&state, invalid).is_err());

        let created = create_channel_with_state(&state, test_channel("id-ignored")).unwrap();
        // 返回打码后的 key，数据库里保存原 key
        assert!(created.api_key.starts_with("sk-***"));
        assert_eq!(
            state
                .repo
                .get_channel(&created.id)
                .unwrap()
                .unwrap()
                .api_key,
            "sk-test"
        );
    }

    #[test]
    fn update_channel_with_masked_key_preserves_original() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        // 编辑时前端可能回传打码 key，应还原原值并通过校验
        let mut c = test_channel("ch1");
        c.name = "  重命名 ".into();
        c.base_url = " https://api.openai.com ".into();
        c.api_key = "sk-***test".into();
        update_channel_with_state(&state, c).unwrap();

        let stored = state.repo.get_channel("ch1").unwrap().unwrap();
        assert_eq!(stored.api_key, "sk-test");
        // name / base_url 在存储前被 trim，避免带空白值在 reqwest 解析时失败
        assert_eq!(stored.name, "重命名");
        assert_eq!(stored.base_url, "https://api.openai.com");
    }

    #[test]
    fn update_channel_short_masked_key_preserves_original() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        // 短 key（≤4 字符）打码后为 "****"，也应还原原值而不是覆盖为打码串
        let mut c = test_channel("ch1");
        c.api_key = "****".into();
        update_channel_with_state(&state, c).unwrap();

        let stored = state.repo.get_channel("ch1").unwrap().unwrap();
        assert_eq!(stored.api_key, "sk-test");
    }

    #[test]
    fn create_channel_trims_name_and_base_url() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);

        let mut c = test_channel("id-ignored");
        c.name = "  带空格名称  ".into();
        c.base_url = "  https://api.openai.com  ".into();
        let created = create_channel_with_state(&state, c).unwrap();

        let stored = state.repo.get_channel(&created.id).unwrap().unwrap();
        assert_eq!(stored.name, "带空格名称");
        assert_eq!(stored.base_url, "https://api.openai.com");
    }

    #[test]
    fn update_channel_validates_after_unmask() {
        let db = Db::new_in_memory().unwrap();
        let state = AppState::new(db);
        state.repo.insert_channel(&test_channel("ch1")).unwrap();

        // 空模型即使 api_key 已还原也应被拒绝
        let mut c = test_channel("ch1");
        c.api_key = "sk-***test".into();
        c.models = vec![];
        assert_eq!(
            update_channel_with_state(&state, c),
            Err("至少需要一个模型".into())
        );
    }
}
