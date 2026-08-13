# MCP Server

llm-gateway 内嵌 MCP Server(Streamable HTTP),MCP 客户端可连接并调用知识库工具。

## 连接

- URL:`http://127.0.0.1:<port>/mcp`(网关端口 8777-8787 中实际占用者)
- 鉴权:复用本地 API key,头 `Authorization: Bearer sk-lgw-...`(或 `x-api-key`)
- 获取密钥:网关前端「API 密钥」页创建

Claude Code `~/.claude.json` 的 mcpServers 配置示例:
```json
{ "mcpServers": { "llm-gateway": {
  "url": "http://127.0.0.1:8779/mcp",
  "headers": { "Authorization": "Bearer sk-lgw-<你的密钥>" }
}}}
```

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| kb_list_bases | - | 列出所有知识库 |
| kb_get_base | kb_id | 单库详情 + 文档数(id 或 name) |
| kb_search | query, kb_id?, top_k? | 检索片段(默认库/默认 5/上限 20) |
| kb_create | name, description?, embedding_channel_id?, embedding_model | 建库 |
| kb_upload | kb_id, filename, content | 上传纯文本文档(异步摄取) |
| kb_delete | kb_id | 删除库(级联+索引) |
| stats_quota | - | 全局用量统计 |

## 冒烟

```bash
# 起 app 后,用任意 MCP client 连接;或:
curl -s -X POST http://127.0.0.1:8779/mcp -H 'Authorization: Bearer sk-lgw-xxx' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```
