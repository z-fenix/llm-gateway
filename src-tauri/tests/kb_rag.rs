mod common;

use llm_gateway_lib::db::models::{ApiKey, Channel, KbDocument, KnowledgeBase};
use llm_gateway_lib::db::repository::Repository;
use llm_gateway_lib::db::Db;
use llm_gateway_lib::knowledge::ingest::{spawn_ingest, stage_content};
use llm_gateway_lib::proxy::{server, state::AppState};
use std::path::Path;
use std::time::Duration;

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

/// 聊天上游渠道：高优先级，保证普通调度时先于 embedding 渠道被选中。
fn chat_channel(id: &str, base_url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: base_url.into(),
        api_key: "sk-real".into(),
        models: vec!["gpt-4o".into()],
        priority: 10,
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

/// embedding 上游渠道：低优先级，避免被聊天普通调度选中(只服务 /v1/embeddings)。
fn embedding_channel(id: &str, base_url: &str) -> Channel {
    Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: base_url.into(),
        api_key: "sk-embed-test".into(),
        models: vec!["text-embedding-3-small".into()],
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

fn kb(name: &str) -> KnowledgeBase {
    KnowledgeBase {
        id: format!("kb-{name}"),
        name: name.into(),
        description: None,
        embedding_channel_id: Some("emb".into()),
        embedding_model: "text-embedding-3-small".into(),
        dim: 4,
        doc_count: 0,
        chunk_count: 0,
        enabled: true,
        created_at: 1,
        updated_at: 1,
        needs_reindex: false,
    }
}

fn doc(id: &str, kb_id: &str) -> KbDocument {
    KbDocument {
        id: id.into(),
        kb_id: kb_id.into(),
        filename: "notes.md".into(),
        file_type: "md".into(),
        size_bytes: 0,
        chunk_count: 0,
        status: "indexing".into(),
        error: None,
        created_at: 1,
    }
}

fn ok_chat_body() -> serde_json::Value {
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

fn chat_body(query: &str) -> serde_json::Value {
    serde_json::json!({
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": query}]
    })
}

/// 轮询直到文档进入目标状态；失败(或超时)会 panic，保证测试确定性而非 flaky。
async fn wait_for_status(state: &AppState, doc_id: &str, expected: &str) {
    for _ in 0..300 {
        if let Some(d) = state.repo.get_document(doc_id).unwrap() {
            if d.status == expected {
                return;
            }
            if d.status == "failed" {
                panic!("document {} failed: {:?}", doc_id, d.error);
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for document {} to become {}", doc_id, expected);
}

/// 公共 setup：建聊天渠道 + embedding 渠道 + 知识库，摄取一文档并等待 indexed。
/// `index_dir` 由调用方用 `tempfile::tempdir()` 提供并保持存活到测试结束。
async fn setup_rag(
    chat_base: &str,
    embed_base: &str,
    index_dir: &Path,
    doc_id: &str,
    kb_name: &str,
    doc_content: &[u8],
) -> (AppState, Repository) {
    let db = Db::new_in_memory().unwrap();
    let repo = Repository::new(db.clone());
    repo.insert_api_key(&api_key()).unwrap();
    repo.insert_channel(&chat_channel("chat", chat_base)).unwrap();
    repo.insert_channel(&embedding_channel("emb", embed_base)).unwrap();

    let state = AppState::new(db);
    *state.kb_index_dir.write() = index_dir.to_path_buf();

    repo.create_kb(&kb(kb_name)).unwrap();
    let d = doc(doc_id, &format!("kb-{kb_name}"));
    repo.insert_document(&d).unwrap();
    stage_content(&state, &d.id, doc_content).unwrap();
    spawn_ingest(state.clone(), d.id.clone());
    wait_for_status(&state, &d.id, "indexed").await;

    (state, repo)
}

fn enable_rag(state: &AppState, default_kb: &str) {
    let mut rag = state.rag.write();
    rag.enabled = true;
    rag.default_kb = Some(default_kb.to_string());
}

/// 场景 1:注入 e2e —— RAG 开启 + 相关 query,上游 body 出现 `[知识库参考资料]` system 内容。
#[tokio::test]
async fn rag_injects_context_into_upstream() {
    let (chat_base, embed_base, mocks) =
        common::spawn_mock_with_embeddings(200, ok_chat_body(), 200).await;
    let temp = tempfile::tempdir().unwrap();

    let (state, _repo) = setup_rag(
        &chat_base,
        &embed_base,
        temp.path(),
        "doc-rag",
        "rag-kb",
        b"quantum computing basics and entanglement explained",
    )
    .await;
    enable_rag(&state, "rag-kb");

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&chat_body("quantum entanglement"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let hits = mocks.chat.hits.lock().unwrap();
    assert_eq!(hits.len(), 1, "chat upstream should be hit exactly once");
    let msgs = hits[0]["messages"].as_array().expect("upstream body must have messages");
    let system = msgs
        .iter()
        .find(|m| m["role"] == "system")
        .expect("injected context should add a system message");
    let content = system["content"].as_str().expect("system content should be a string");
    assert!(
        content.contains("[知识库参考资料]"),
        "system content should contain the kb header: {content}"
    );
    assert!(
        content.contains("quantum"),
        "injected context should contain the retrieved chunk text: {content}"
    );

    // embedding 至少被摄取与检索 query 各调用一次。
    assert!(!mocks.embeddings.hits.lock().unwrap().is_empty());
}

/// 场景 2:x-kb: off —— 同一 setup,显式关闭后上游 body 无注入。
#[tokio::test]
async fn x_kb_off_skips_injection() {
    let (chat_base, embed_base, mocks) =
        common::spawn_mock_with_embeddings(200, ok_chat_body(), 200).await;
    let temp = tempfile::tempdir().unwrap();

    let (state, _repo) = setup_rag(
        &chat_base,
        &embed_base,
        temp.path(),
        "doc-rag",
        "rag-kb",
        b"quantum computing basics and entanglement explained",
    )
    .await;
    enable_rag(&state, "rag-kb");

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .header("x-kb", "off")
        .json(&chat_body("quantum entanglement"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let hits = mocks.chat.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let upstream = hits[0].to_string();
    assert!(
        !upstream.contains("[知识库参考资料]"),
        "x-kb:off must skip context injection: {upstream}"
    );
}

/// 场景 3:降级 e2e —— embedding 上游 500,聊天仍 200、无注入、客户端无报错。
#[tokio::test]
async fn embedding_failure_degrades_gracefully() {
    let (chat_base, embed_base, mocks) =
        common::spawn_mock_with_embeddings(200, ok_chat_body(), 200).await;
    let temp = tempfile::tempdir().unwrap();

    let (state, _repo) = setup_rag(
        &chat_base,
        &embed_base,
        temp.path(),
        "doc-rag",
        "rag-kb",
        b"quantum computing basics and entanglement explained",
    )
    .await;
    enable_rag(&state, "rag-kb");

    // 摄取完成后把 embedding 上游切到 500，模拟检索期故障。
    *mocks.embeddings.respond_status.lock().unwrap() = 500;

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&chat_body("quantum entanglement"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(
        body["choices"].is_array(),
        "client should receive a normal completion, got: {body}"
    );

    let hits = mocks.chat.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let upstream = hits[0].to_string();
    assert!(
        !upstream.contains("[知识库参考资料]"),
        "embedding failure should skip injection: {upstream}"
    );
}

/// 场景 4:注入内容过安检 —— 库文档含敏感串,redact 模式证明注入发生在请求侧安检之前。
#[tokio::test]
async fn injected_context_passes_request_security() {
    let (chat_base, embed_base, mocks) =
        common::spawn_mock_with_embeddings(200, ok_chat_body(), 200).await;
    let temp = tempfile::tempdir().unwrap();

    let (state, repo) = setup_rag(
        &chat_base,
        &embed_base,
        temp.path(),
        "doc-rag",
        "rag-kb",
        b"quantum secret: my key is sk-123456789012345678901234",
    )
    .await;
    enable_rag(&state, "rag-kb");

    {
        let mut sec = state.security.write();
        sec.enabled = true;
        sec.mode = "redact".into();
        sec.scan_request = true;
        sec.redact_secrets = true;
    }

    let (_h, addr) = server::start(state.clone(), 0).await.unwrap();
    let resp = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", addr))
        .header("authorization", "Bearer sk-lgw-test")
        .json(&chat_body("quantum"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let _ = resp.text().await;

    let hits = mocks.chat.hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    let msgs = hits[0]["messages"].as_array().unwrap();
    let system = msgs.iter().find(|m| m["role"] == "system").unwrap();
    let content = system["content"].as_str().unwrap();
    // 注入确实发生(头文案仍在),且注入的敏感串已被请求侧安检脱敏。
    assert!(content.contains("[知识库参考资料]"), "{content}");
    assert!(content.contains("sk-****"), "secret should be redacted: {content}");
    assert!(
        !content.contains("sk-123456789012345678901234"),
        "raw secret must not reach upstream: {content}"
    );

    // 日志与 findings 也证明:注入发生在安检前,安检在注入后的 body 上命中 secret_token。
    let log = repo.latest_log().unwrap().unwrap();
    assert_eq!(log.security_action, "redact");
    assert!(log.sanitized);
    let findings = repo.get_findings(&log.id).unwrap();
    assert!(
        findings
            .iter()
            .any(|f| f.phase == "request" && f.rule_id == "credential.secret_token"),
        "expected a request-phase credential.secret_token finding: {:?}",
        findings
    );
}
