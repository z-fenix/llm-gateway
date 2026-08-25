//! Task 6a 集成测试：迁移 014 生效、旧行缺省读取、写时成本 + backfill、timeseries 聚合。
//! 仿 tests/logs_enhanced.rs 的 Repository 驱动模式，但用 tempdir 文件 Db（走完整迁移）。

use llm_gateway_lib::db::models::{ApiKey, Channel, ModelPrice};
use llm_gateway_lib::db::repository::{LogFilter, Repository};
use llm_gateway_lib::db::Db;

fn channel(id: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: "http://x".into(),
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

#[allow(clippy::too_many_arguments)]
fn make_log(
    seq: i64,
    protocol: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    created_at: i64,
) -> llm_gateway_lib::db::models::RequestLog {
    llm_gateway_lib::db::models::RequestLog {
        id: format!("l{}", seq),
        seq,
        trace_id: format!("t{}", seq),
        api_key_id: Some("k1".into()),
        key_name: Some("t".into()),
        channel_id: Some("c1".into()),
        channel_name: Some("c1".into()),
        role: Some("auto".into()),
        request_model: Some(model.into()),
        upstream_model: Some(model.into()),
        protocol: protocol.into(),
        status_code: Some(200),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        input_cost_usd: 0.0,
        output_cost_usd: 0.0,
        cache_read_cost_usd: 0.0,
        cache_creation_cost_usd: 0.0,
        total_cost_usd: 0.0,
        pricing_model: None,
        latency_ms: 100,
        is_stream: false,
        error: None,
        fallback: false,
        tool_calls: None,
        request_body: None,
        response_body: None,
        risk_level: "clean".into(),
        risk_score: 0,
        risk_summary: None,
        security_action: "allow".into(),
        sanitized: false,
        blocked_reason: None,
        session_id: None,
        session_provider: None,
        created_at,
    }
}

fn price(model_id: &str) -> ModelPrice {
    ModelPrice {
        model_id: model_id.into(),
        display_name: model_id.into(),
        input_cost_per_million: 3.0,
        output_cost_per_million: 15.0,
        cache_read_cost_per_million: 0.3,
        cache_creation_cost_per_million: 3.0,
        updated_at: 1,
    }
}

#[test]
fn migration_014_applies_and_legacy_rows_read_zero() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("llm-gateway.db");
    let db = Db::open(&db_path).unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1")).unwrap();
    repo.insert_api_key(&api_key()).unwrap();

    // 迁移生效：新列与 model_pricing 表存在
    {
        let conn = db.conn();
        let conn = conn.lock();
        for col in [
            "cache_read_tokens",
            "cache_creation_tokens",
            "input_cost_usd",
            "output_cost_usd",
            "cache_read_cost_usd",
            "cache_creation_cost_usd",
            "total_cost_usd",
            "pricing_model",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('request_logs') WHERE name=?1",
                    [col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "column {col} should exist after migration 014");
        }
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='model_pricing'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 1, "model_pricing table should exist");
    }

    // 模拟迁移前旧行：只写旧列，新列走 DEFAULT 0/NULL
    {
        let conn = db.conn();
        let conn = conn.lock();
        conn.execute(
            "INSERT INTO request_logs (id,seq,trace_id,api_key_id,key_name,channel_id,channel_name,role,request_model,upstream_model,protocol,status_code,input_tokens,output_tokens,latency_ms,is_stream,error,fallback,tool_calls,request_body,response_body,risk_level,risk_score,risk_summary,security_action,sanitized,blocked_reason,session_id,session_provider,created_at)
             VALUES ('legacy1',1,'t-legacy','k1','t','c1','c1','auto','gpt-4o','gpt-4o','openai-chat',200,10,5,100,0,NULL,0,NULL,NULL,NULL,'clean',0,NULL,'allow',0,NULL,NULL,NULL,1)",
            [],
        )
        .unwrap();
    }
    let logs = repo.list_logs(&LogFilter::default(), 10, 0).unwrap();
    let legacy = logs.iter().find(|l| l.id == "legacy1").unwrap();
    assert_eq!(legacy.cache_read_tokens, 0);
    assert_eq!(legacy.cache_creation_tokens, 0);
    assert_eq!(legacy.input_cost_usd, 0.0);
    assert_eq!(legacy.output_cost_usd, 0.0);
    assert_eq!(legacy.cache_read_cost_usd, 0.0);
    assert_eq!(legacy.cache_creation_cost_usd, 0.0);
    assert_eq!(legacy.total_cost_usd, 0.0);
    assert_eq!(legacy.pricing_model, None);
}

#[test]
fn write_time_cost_and_backfill_on_tempdir_db() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("llm-gateway.db");
    let db = Db::open(&db_path).unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1")).unwrap();
    repo.insert_api_key(&api_key()).unwrap();

    // 无价格时写日志 → 成本 0，但仍记录 pricing_model 供日后 backfill
    repo.insert_log(&make_log(1, "openai-chat", "gpt-4o", 100, 20, 40, 10, 1))
        .unwrap();
    let got0 = repo
        .list_logs(&LogFilter::default(), 10, 0)
        .unwrap()
        .into_iter()
        .find(|l| l.id == "l1")
        .unwrap();
    assert_eq!(got0.total_cost_usd, 0.0);
    assert_eq!(got0.pricing_model.as_deref(), Some("gpt-4o"));

    // upsert 定价 + backfill → 成本按 inclusive 协议重算（billable = 100−40−10 = 50）
    repo.upsert_model_price(&price("gpt-4o")).unwrap();
    let affected = repo.recompute_cost_for_model("gpt-4o").unwrap();
    assert_eq!(affected, 1);
    let got1 = repo
        .list_logs(&LogFilter::default(), 10, 0)
        .unwrap()
        .into_iter()
        .find(|l| l.id == "l1")
        .unwrap();
    let expected = 50.0 * 3.0 / 1e6 + 20.0 * 15.0 / 1e6 + 40.0 * 0.3 / 1e6 + 10.0 * 3.0 / 1e6;
    assert!((got1.total_cost_usd - expected).abs() < 1e-12);
    assert_eq!(got1.pricing_model.as_deref(), Some("gpt-4o"));

    // 删除定价 + backfill → 成本归 0
    repo.delete_model_price("gpt-4o").unwrap();
    let affected2 = repo.recompute_cost_for_model("gpt-4o").unwrap();
    assert_eq!(affected2, 1);
    let got2 = repo
        .list_logs(&LogFilter::default(), 10, 0)
        .unwrap()
        .into_iter()
        .find(|l| l.id == "l1")
        .unwrap();
    assert_eq!(got2.total_cost_usd, 0.0);

    // 定价表 CRUD 校验
    repo.upsert_model_price(&price("gpt-4o")).unwrap();
    let prices = repo.list_model_prices().unwrap();
    assert_eq!(prices.len(), 1);
    assert_eq!(prices[0].model_id, "gpt-4o");
    assert_eq!(
        repo.resolve_pricing("gpt-4o").unwrap().unwrap().model_id,
        "gpt-4o"
    );
    assert!(repo.resolve_pricing("no-such-model").unwrap().is_none());
}

#[test]
fn timeseries_bucket_aggregates_cache_cost_fresh_input() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("llm-gateway.db");
    let db = Db::open(&db_path).unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_channel(&channel("c1")).unwrap();
    repo.insert_api_key(&api_key()).unwrap();
    repo.upsert_model_price(&price("gpt-4o")).unwrap();

    // 同桶：一条 inclusive（含缓存），一条 exclusive（fresh input）
    repo.insert_log(&make_log(1, "openai-chat", "gpt-4o", 100, 20, 40, 10, 5))
        .unwrap();
    repo.insert_log(&make_log(
        2,
        "anthropic-messages",
        "gpt-4o",
        50,
        10,
        5,
        2,
        5,
    ))
    .unwrap();

    let series = repo.log_timeseries(&LogFilter::default(), 60, 0).unwrap();
    assert_eq!(series.len(), 1);
    let b = &series[0];
    assert_eq!(b.calls, 2);
    assert_eq!(b.input_tokens, 150);
    assert_eq!(b.output_tokens, 30);
    assert_eq!(b.cache_read_tokens, 45);
    assert_eq!(b.cache_creation_tokens, 12);
    // fresh_input = (100−40−10) + 50 = 100
    assert_eq!(b.fresh_input, 100);
    let cost1 = 50.0 * 3.0 / 1e6 + 20.0 * 15.0 / 1e6 + 40.0 * 0.3 / 1e6 + 10.0 * 3.0 / 1e6;
    let cost2 = 50.0 * 3.0 / 1e6 + 10.0 * 15.0 / 1e6 + 5.0 * 0.3 / 1e6 + 2.0 * 3.0 / 1e6;
    assert!((b.cost - (cost1 + cost2)).abs() < 1e-12);

    // log_stats 同口径聚合
    let stats = repo.log_stats(&LogFilter::default()).unwrap();
    assert_eq!(stats.cache_read_tokens, 45);
    assert_eq!(stats.cache_creation_tokens, 12);
    assert!((stats.cost - (cost1 + cost2)).abs() < 1e-12);
}
