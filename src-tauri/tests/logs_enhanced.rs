mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel};
use llm_gateway_lib::db::repository::{LogFilter, Repository, StatusClass};
use llm_gateway_lib::db::Db;
use llm_gateway_lib::proxy::{server, state::AppState};

fn api_key() -> ApiKey {
    ApiKey {
        id: "k1".into(),
        key: "sk-lgw-test".into(),
        name: "t".into(),
        enabled: true,
        quota_total: None,
        quota_used: 0,
        total_calls: 0,
        total_tokens: 0,
        created_at: 1,
        last_used_at: None,
    }
}

fn channel(id: &str, base_url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: base_url.into(),
        api_key: "sk-real".into(),
        models: vec!["gpt-4o".into()],
        priority: 0,
        weight: 1,
        enabled: true,
        timeout_secs: 5,
        total_calls: 0,
        total_tokens: 0,
        success_rate: 1.0,
        avg_latency_ms: 0,
        created_at: 1,
        updated_at: 1,
    }
}

fn clean_body() -> serde_json::Value {
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "hello"}]
    })
}

fn secret_body() -> serde_json::Value {
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "my key is sk-123456789012345678901234"}]
    })
}

fn ok_upstream_body() -> serde_json::Value {
    serde_json::json!({
        "id": "c1",
        "object": "chat.completion",
        "model": "gpt-4o",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "hi"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    })
}

async fn setup(base_url: &str) -> (AppState, Repository) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_api_key(&api_key()).unwrap();
    repo.insert_channel(&channel("c1", base_url)).unwrap();
    let state = AppState::new(db);
    (state, repo)
}

fn set_security_audit(state: &AppState) {
    let mut sec = state.security.write();
    sec.enabled = true;
    sec.mode = "audit".into();
    sec.scan_request = true;
    sec.scan_response = false;
}

#[tokio::test]
async fn multi_condition_filter_e2e() {
    let (base, _mock) = common::spawn_mock(200, ok_upstream_body()).await;
    let (state, _repo) = setup(&base).await;
    set_security_audit(&state);

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let url = format!("http://{}/v1/chat/completions", addr);
    let client = reqwest::Client::new();

    // 1. 正常请求：200，channel=c1，risk=clean
    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    // 2. 非法密钥：401，channel=null，risk=clean
    let resp = client
        .post(&url)
        .header("authorization", "Bearer invalid-key")
        .json(&clean_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let _ = resp.text().await;

    // 3. 含敏感 token 的审计请求：200，channel=c1，risk=high
    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let filter = LogFilter {
        channel_id: Some("c1".into()),
        risk_level: Some("high".into()),
        status: Some(StatusClass::Success),
        ..Default::default()
    };

    let items = state.repo.list_logs(&filter, 100, 0).unwrap();
    assert_eq!(items.len(), 1, "expected exactly the high-risk audit log");
    assert_eq!(items[0].channel_id.as_deref(), Some("c1"));
    assert_eq!(items[0].risk_level, "high");
    assert_eq!(items[0].status_code, Some(200));

    let count = state.repo.count_logs(&filter).unwrap();
    assert_eq!(count, 1, "count_logs must agree with list_logs");
}

#[tokio::test]
async fn log_stats_reflects_real_requests() {
    let (base, _mock) = common::spawn_mock(200, ok_upstream_body()).await;
    let (state, _repo) = setup(&base).await;
    set_security_audit(&state);

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let url = format!("http://{}/v1/chat/completions", addr);
    let client = reqwest::Client::new();

    // 正常 200
    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    // 非法密钥 401
    let resp = client
        .post(&url)
        .header("authorization", "Bearer bad-key")
        .json(&clean_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let _ = resp.text().await;

    // 敏感 token 审计 200
    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let stats = state.repo.log_stats(&LogFilter::default()).unwrap();
    assert_eq!(stats.total_calls, 3);
    assert_eq!(stats.success_count, 2);
    assert_eq!(stats.total_input_tokens, 20);
    assert_eq!(stats.total_output_tokens, 10);
    assert!(
        stats.risk_distribution.contains(&("clean".into(), 2)),
        "risk_distribution should include clean=2: {:?}",
        stats.risk_distribution
    );
    assert!(
        stats.risk_distribution.contains(&("high".into(), 1)),
        "risk_distribution should include high=1: {:?}",
        stats.risk_distribution
    );
    assert_eq!(stats.top_channels, vec![("c1".into(), 2)]);
    assert_eq!(stats.top_api_keys, vec![("t".into(), 2)]);

    // 趋势接口同样不返回 body，仅做聚合断言
    let buckets = state.repo.log_timeseries(&LogFilter::default(), 60).unwrap();
    assert_eq!(buckets.len(), 1);
    let bucket = &buckets[0];
    assert_eq!(bucket.calls, 3);
    assert_eq!(bucket.error_count, 1);
    assert_eq!(bucket.risk_counts.get("clean").copied().unwrap_or(0), 2);
    assert_eq!(bucket.risk_counts.get("high").copied().unwrap_or(0), 1);
}

#[tokio::test]
async fn delete_logs_before_cascades_findings() {
    let (base, _mock) = common::spawn_mock(200, ok_upstream_body()).await;
    let (state, _repo) = setup(&base).await;
    set_security_audit(&state);

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let url = format!("http://{}/v1/chat/completions", addr);
    let client = reqwest::Client::new();

    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let log = state.repo.latest_log().unwrap().unwrap();
    assert_eq!(log.risk_level, "high");
    let findings = state.repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().any(|f| f.phase == "request"),
        "expected request-phase findings before delete"
    );

    let before_ts = chrono::Utc::now().timestamp() + 3600;
    let deleted = state.repo.delete_logs_before(before_ts).unwrap();
    assert_eq!(deleted, 1);

    assert_eq!(state.repo.count_logs(&LogFilter::default()).unwrap(), 0);
    assert!(
        state.repo.get_findings(&log.id).unwrap().is_empty(),
        "findings for deleted log_id must be removed"
    );
}

#[tokio::test]
async fn clear_logs_empties_both_tables() {
    let (base, _mock) = common::spawn_mock(200, ok_upstream_body()).await;
    let (state, _repo) = setup(&base).await;
    set_security_audit(&state);

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let url = format!("http://{}/v1/chat/completions", addr);
    let client = reqwest::Client::new();

    // 正常请求 + 敏感 token 请求，各产生一条日志，后者附带 findings
    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&clean_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let resp = client
        .post(&url)
        .header("authorization", "Bearer sk-lgw-test")
        .json(&secret_body())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let log = state.repo.latest_log().unwrap().unwrap();
    assert_eq!(log.risk_level, "high");
    let findings = state.repo.get_findings(&log.id).unwrap();
    assert!(
        findings.iter().any(|f| f.phase == "request"),
        "expected request-phase findings before clear"
    );

    let cleared = state.repo.clear_logs().unwrap();
    assert_eq!(cleared, 2);

    assert_eq!(state.repo.count_logs(&LogFilter::default()).unwrap(), 0);
    assert!(
        state.repo.latest_log().unwrap().is_none(),
        "request_logs should be empty"
    );
    // 用真实 log_id 确认 findings 表随 request_logs 级联清空，无孤儿记录
    assert!(
        state.repo.get_findings(&log.id).unwrap().is_empty(),
        "findings for deleted log_id must be removed"
    );
}
