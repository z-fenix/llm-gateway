import http from "node:http";

const now = Math.floor(Date.now() / 1000);
const channels = [
  ["Anthropic 主线路", "claude", "anthropic-messages", "https://api.anthropic.com", "claude-sonnet-4-5"],
  ["OpenAI 官方", "openai", "openai-chat", "https://api.openai.com/v1", "gpt-4.1"],
  ["DeepSeek 备用", "deepseek", "openai-chat", "https://api.deepseek.com", "deepseek-chat"],
  ["Gemini 多模态", "gemini", "gemini-native", "https://generativelanguage.googleapis.com", "gemini-2.5-pro"],
  ["测试渠道", "custom", "openai-responses", "https://example.invalid/v1", "test-model"],
].map(([name, supplier, upstream_protocol, base_url, model], i) => ({ id: `c${i}`, name, supplier, upstream_protocol, base_url, api_key: "sk-***demo", models: [model], priority: 100 - i * 20, weight: 3, enabled: i < 4, timeout_secs: 60, total_calls: 12480 - i * 2100, total_tokens: 4800000, success_rate: .992, avg_latency_ms: 842 + i * 200, created_at: now, updated_at: now }));
const keys = ["Claude Code", "开发测试", "团队工具"].map((name, i) => ({ id: `k${i}`, name, key: `sk-demo-not-a-real-key-000${i}`, enabled: i < 2, quota_total: i ? (i === 1 ? 1000000 : null) : 20000000, quota_used: i === 1 ? 1234567 : 8420000, total_calls: 2600 + i * 213, total_tokens: 1800000, created_at: now - 86400, last_used_at: now }));
const roles = ["sonnet", "opus", "fable", "haiku", "image", "auto"];
const logs = channels.map((c, i) => ({ id: `l${i}`, seq: 42608 - i, trace_id: `demo-a7f2-000${i}-9c31`, api_key_id: "k0", key_name: keys[0].name, channel_id: c.id, channel_name: c.name, role: roles[i], request_model: c.models[0], upstream_model: c.models[0], protocol: "openai", status_code: i === 2 ? 429 : 200, input_tokens: 1340, output_tokens: 342, cache_read_tokens: 800, cache_creation_tokens: 0, total_cost_usd: .0126, latency_ms: c.avg_latency_ms, is_stream: true, error: i === 2 ? "上游限流" : null, fallback: false, tool_calls: null, request_body: JSON.stringify({ model: c.models[0], stream: true, messages: [{ role: "user", content: "检查配置 token=[REDACTED]" }] }, null, 2), response_body: JSON.stringify({ role: "assistant", content: "配置检查完成。" }, null, 2), risk_level: i === 1 ? "medium" : "clean", risk_score: 0, risk_summary: null, security_action: "allow", sanitized: true, blocked_reason: null, session_id: "session-demo", session_provider: "claude", created_at: now - i * 60 }));
const fixtures = {
  get_app_config: { preferred_port: 8777, bound_addr: "127.0.0.1:8777", minimize_to_tray: true },
  list_channels: channels, list_channel_models: channels.flatMap(c => c.models), get_model_map: [], list_api_keys: keys,
  get_stats: { today_requests: 42608, today_tokens: 31600000, total_requests: 142608, total_tokens: 93600000, active_channels: 4, avg_latency_ms: 842, today_input_tokens: 24000000, today_output_tokens: 7600000, today_cache_read_tokens: 14976000, today_cache_creation_tokens: 0, today_fresh_input: 9024000, today_cost: 68.24, total_cost: 287.56 },
  list_role_routes: roles.filter(r => r !== "fable").map((role, i) => ({ id: `r${i}`, role, channel_id: `c${i % 4}`, target_model: channels[i % 4].models[0], priority: 100, weight: 3, breaker_max_failures: 5, breaker_cooldown_secs: 60, enabled: true, updated_at: now })),
  list_role_patterns: roles.filter(r => r !== "auto").map((role, i) => ({ id: `p${i}`, role, pattern: `*${role}*`, priority: 100, enabled: true })),
  get_breaker_status: [{ route_id: "r0", state: "closed", failures: 0 }, { route_id: "r1", state: "half_open", failures: 2 }, { route_id: "r2", state: "open", failures: 5 }, { route_id: "r3", state: "closed", failures: 0 }], get_role_stats: roles.map(role => ({ role, requests: 12480, tokens: 9400000, success_count: 12400, avg_latency_ms: 842 })), get_fallback: ["c2", "deepseek-chat"],
  list_logs: { items: logs, total: logs.length }, get_log_stats: { total_calls: 42608, total_input_tokens: 24000000, total_output_tokens: 7600000, cache_read_tokens: 14976000, cache_creation_tokens: 0, cost: 68.24, success_count: 42267, risk_distribution: [["clean", 42000], ["medium", 608]], top_channels: [[channels[0].name, 12480]], top_api_keys: [[keys[0].name, 18000]] },
  get_log_retention_days: 30, get_security_findings: [{ id: "finding", log_id: "l0", phase: "request", category: "secrets", rule_id: "secret", severity: "medium", title: "敏感凭据已脱敏", description: "日志不会展示原始凭据", location: "messages", evidence_masked: "[REDACTED]", evidence_hash: null, action: "redact", created_at: now }],
  get_security_settings: { enabled: true, mode: "warn", scan_request: true, scan_response: true, scan_unicode: true, scan_tools: true, scan_network: false, redact_secrets: true, block_on_critical: true, max_scan_bytes: 1048576 },
  get_builtin_security_rules: ["敏感凭据", "提示词注入", "危险命令"].map((title, i) => ({ id: `b${i}`, rule_id: `builtin-${i}`, category: ["secrets", "injection", "command"][i], severity: "high", title, description: "检测请求与响应中的潜在风险", toggle_key: null, enabled: true, created_at: now })), get_custom_security_rules: [],
  list_kbs: ["网关开发文档", "团队 API 规范", "故障知识库"].map((name, i) => ({ id: `kb${i}`, name, description: "开发文档与接口说明", embedding_channel_id: "c1", embedding_model: "text-embedding-3-small", dim: 1536, doc_count: 4, chunk_count: 128, enabled: true, created_at: now, updated_at: now, needs_reindex: false })),
  list_documents: ["architecture.md", "routing-guide.md", "gateway-api.pdf", "troubleshooting.md"].map((filename, i) => ({ id: `doc${i}`, kb_id: "kb0", filename, file_type: filename.split(".").pop(), size_bytes: 28560, chunk_count: 32, status: "ready", error: null, created_at: now })),
  get_rag_settings: { enabled: true, default_kb: "kb0", default_embedding_channel: "c1" },
  list_prompts: ["默认开发模板", "代码审查", "技术写作"].map((name, i) => ({ id: `prompt${i}`, name, description: "适用于日常开发与协作", content: "# 开发协作约定\n\n## 工作方式\n- 先理解上下文，再修改代码\n- 保持改动小而清晰\n- 为关键行为编写测试\n\n## 输出规范\n使用中文交流，代码保持项目原有风格。", enabled: i === 0, created_at: now, updated_at: now })),
  list_sessions: ["完善角色路由与自动回退", "排查连接超时", "整理接口文档"].map((title, i) => ({ providerId: "claude", sessionId: `session-${i}`, title, summary: "检查配置并验证网关行为", projectDir: "D:/workspace/llm-gateway", sourcePath: `/demo/session-${i}.jsonl`, createdAt: now * 1000, lastActiveAt: (now - i * 3600) * 1000, resumeCommand: `claude --resume session-${i}` })),
  get_session_messages: [{ role: "user", content: "请检查角色路由配置，确保失败后能自动回退。", ts: now * 1000 }, { role: "tool", content: "src/router/config.ts\n读取完成：priority = 100, cooldown = 60s\n这是合成工具输出，不会读取真实本地文件。", ts: (now + 1) * 1000 }, { role: "assistant", content: "已检查路由优先级与回退配置。接下来验证熔断阈值和冷却时间，并补充相关测试。", ts: (now + 2) * 1000 }],
  list_mcp_servers: ["Filesystem", "Documentation", "Browser tools"].map((name, i) => ({ connected: i < 2, server: { id: `mcp${i}`, name, description: "供开发工具使用的上游 MCP 服务", server_config: { type: "stdio", command: "npx", args: ["-y", "demo-server"] }, enabled: i < 2, created_at: now, updated_at: now } })),
  list_skills: ["代码审查", "前端设计", "知识库检索", "发布检查"].map((name, i) => ({ synced: i < 2, skill: { id: `skill${i}`, name, directory: `demo-skill-${i}`, description: "让开发流程更清晰、更可靠", content: "# Skill\n\n仅为视觉验收的合成数据。", enabled: i < 2, created_at: now, updated_at: now } })), list_installed_skills: [],
  get_rectifier_config: { enabled: true, request_thinking_signature: true, request_thinking_budget: true, request_media_fallback: true, request_media_heuristic: false },
  get_cli_targets: [{ target: "claude_code", configured: true, path: "~/.claude/settings.json" }, { target: "codex", configured: false, path: "~/.codex/config.toml" }], read_cli_config: '{\n  "env": {}\n}', list_model_prices: [], default_export_path: "gateway-config.json",
};
function installPreview(fixtures) {
 window.__DESIGN_PREVIEW__=true; document.title='Gateway · 只读设计预览';
 window.__TAURI_INTERNALS__={invoke:async(cmd,args={})=>{
  const f=structuredClone(fixtures); const params=new URLSearchParams(location.search);const mode=params.get('state');
  if(cmd!=='get_log_timeseries'&&!(cmd in f))throw new Error('只读设计预览：禁止执行 '+cmd);
  if(mode==='loading')return new Promise(()=>{});
  if(mode==='error')throw new Error('模拟连接失败：请重试');
  if(cmd==='list_channel_models') {
   if(params.get('models')==='error')throw new Error('上游返回状态码 401（合成测试）');
   if(params.get('models')==='empty')return [];
   return args.upstreamProtocol==='anthropic-messages'?['claude-sonnet-4-5','claude-haiku-4-5']:args.upstreamProtocol==='gemini-native'?['gemini-2.5-pro','gemini-2.5-flash']:['gpt-4.1','gpt-4o','deepseek-chat'];
  }
  const turn=i=>[{role:'user',content:`第 ${i+1} 轮：检查角色路由配置与失败回退。`,ts:Date.now()},
   {role:'assistant',content:'读取配置',blocks:[{type:'thinking',text:'先检查配置，再验证失败路径。'},{type:'tool_call',id:'read-'+i,name:'Read',input:{path:'src/router/config.ts'}}]},
   {role:'tool',content:'priority = 100; cooldown = 60',blocks:[{type:'tool_result',id:'read-'+i,output:'priority = 100; cooldown = 60; synthetic-needle-'+i,status:i===1?'error':'success'}]},
   {role:'assistant',content:'## 配置检查完成\n\n- 优先级与回退配置已检查\n- 补充熔断恢复测试\n\n```typescript\nconst priority = 100;\nconst cooldown = 60;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 回退 | 已验证 |'}];
  f.get_session_messages=Array.from({length:3},(_,i)=>turn(i)).flat();
  if(mode==='long') {
   f.list_channels=f.list_channels.map(c=>({...c,name:c.name+' · '+'long-channel-'.repeat(12),models:Array.from({length:16},(_,i)=>'long-model-'+i+'-'+('model-'.repeat(12)))}));
   f.list_sessions=f.list_sessions.map(s=>({...s,title:s.title+' · '+'long-session-'.repeat(12),projectDir:'D:/'+('deep/project/'.repeat(30))}));
   f.get_session_messages=Array.from({length:220},(_,i)=>turn(i)).flat();
   f.get_session_messages[2].blocks[0].output='long-output-'.repeat(8000);
  }
  if(cmd==='get_log_timeseries') {
   if(mode==='empty')return [];const now=Math.floor(Date.now()/1000);const start=args.filter?.after||now-86400,end=args.filter?.before||now;
   return Array.from({length:Math.min(48,Math.ceil((end-start)/args.bucket))},(_,i)=>({bucket:start+i*args.bucket,calls:200+(i*137)%900,input_tokens:30000,output_tokens:10000,cache_read_tokens:18000,cache_creation_tokens:0,error_count:i%3,cost:.3,risk_counts:{clean:200}}));
  }
  const value=f[cmd];if(mode==='empty'&&cmd==='list_logs')return {items:[],total:0};return mode==='empty'&&Array.isArray(value)?[]:value;
 }};
}
const bridge = '(' + installPreview.toString() + ')(' + JSON.stringify(fixtures) + ');';
const upstreamPort = Number(process.env.RENDERER_PORT || 5173);
const server = http.createServer((req, res) => {
  if (req.url === "/__design-preview.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bridge); return; }
  const proxy = http.request({ host: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, "accept-encoding": "identity" } }, upstream => {
    const chunks = [];
    upstream.on("data", chunk => chunks.push(chunk));
    upstream.on("end", () => {
      let body = Buffer.concat(chunks);
      const headers = { ...upstream.headers };
      if (headers["content-type"]?.includes("text/html")) {
        body = Buffer.from(body.toString().replace("<head>", '<head><script src="/__design-preview.js"></script>'));
        delete headers["content-length"];
        delete headers.etag;
      }
      res.writeHead(upstream.statusCode, headers); res.end(body);
    });
  });
  proxy.on("error", () => { res.writeHead(502); res.end("Start pnpm dev:renderer on port 5173 first."); });
  req.pipe(proxy);
});
const port = Number(process.env.PREVIEW_PORT || 5174);
server.listen(port, "127.0.0.1", () => console.log(`Read-only design preview: http://127.0.0.1:${port} (synthetic data; mutations blocked)`));
