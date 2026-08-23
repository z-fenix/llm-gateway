# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

This is a Tauri v2 desktop application: a local LLM API gateway. The frontend is React + Vite + Tailwind CSS + TypeScript; the backend is Rust. It exposes OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages`, OpenAI `/v1/responses`, `/v1/models`, `/health`, and an MCP server at `/mcp`.

The headline feature is role-based routing for Claude Code models: requests whose model name matches a role pattern (`sonnet`, `opus`, `fable`, `haiku`) are routed to a configured upstream channel and model. Unmatched requests fall back to weighted priority scheduling or a global fallback channel.

## Common commands

This project uses `pnpm`. All backend commands should be run from `src-tauri/`.

### Development

- Start the desktop app in dev mode (Vite renderer + Tauri backend):  
  `pnpm dev`
- Start only the Vite renderer for quick UI iteration:  
  `pnpm dev:renderer`
- Type-check the frontend:  
  `pnpm typecheck`

### Build

- Build the production desktop app:  
  `pnpm build`
- Build only the frontend bundle:  
  `pnpm build:renderer`

### Rust tests

Run from `src-tauri/`:

- Run all unit + integration tests (`.cargo/config.toml` already forces `RUST_TEST_THREADS=1`):  
  `cargo test`
- Run only library unit tests:  
  `cargo test --lib`
- Run a single test by full path:  
  `cargo test --lib router::dispatch::tests::role_route_beats_normal_and_appends_fallback -- --nocapture`
- Run one integration test file:  
  `cargo test --test gateway_e2e`

### Frontend tests

- Run Vitest unit tests once:  
  `pnpm test:unit`
- Run Vitest in watch mode (useful during development):  
  `pnpm vitest`

### Format / lint

- Format Rust code:  
  `cargo fmt`
- Check Rust with Clippy:  
  `cargo clippy`
- There is currently no ESLint/Prettier configuration for the frontend; rely on `pnpm typecheck` and `pnpm test:unit`.

## High-level architecture

### Request lifecycle

A request enters through `proxy::handlers` and flows through these stages:

1. **Authentication / quota** (`auth::authorize`): validates the bearer or `x-api-key` header against the `api_keys` table and checks quota.
2. **Protocol normalization** (`protocol::{openai, anthropic, responses}::request_to_chat`): converts the incoming OpenAI/Anthropic/Responses body into a unified `ChatRequest`.
3. **RAG injection** (`knowledge::rag_hook::maybe_inject`): if RAG is enabled, retrieves chunks from the configured knowledge base and prepends them to the system message. Failures degrade silently.
4. **Request security scan** (`proxy::security_hook::inspect_request`): scans the unified request; may block, redact, or allow.
5. **Role detection** (`router::role::detect_role`): matches `chat.model` against wildcard patterns in `role_patterns` (case-insensitive, `*` is any sequence). Default patterns map `*sonnet*`, `*opus*`, `*haiku*`, `*fable*` to their roles.
6. **Route planning** (`router::dispatch::plan_route`):
   - If a role was detected and a `role_route` exists, that channel+model is used first, optionally followed by the global fallback.
   - Otherwise, enabled channels are ordered by `priority` descending; within the same priority group a seed-stable weighted random pick orders candidates.
   - Model translation is applied per channel via `channel_model_maps` (`router::model_map::resolve_model`).
7. **Upstream forwarding** (`proxy::forwarder`):
   - Builds the upstream body, URL, and auth header according to the channel's `upstream_protocol` (`provider::adapter`).
   - Supported protocols: `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini-native`.
   - Retries/failover: non-role requests try up to `retry_count + 1` candidates; role requests try the role channel and then the fallback. Failover is triggered on 429/401/403/5xx; other 4xx errors return immediately.
8. **Response security scan** (`proxy::security_hook::inspect_response`): scans the upstream response and may block or redact.
9. **Logging & quota** (`db::repository`): writes a `request_logs` row with tokens, latency, role, security verdict, and redacted bodies; deducts quota from the API key.
10. **Protocol denormalization**: converts the unified `ChatResponse` back to the client-facing OpenAI/Anthropic/Responses format.

### Key backend modules

- `proxy::server`: axum router and the TCP listener. The gateway binds to a port in the range 8777–8787 (configurable via `app.preferred_port`, saved in `store.bin`).
- `proxy::state::AppState`: central shared state holding the SQLite `Db`, `Repository`, `reqwest` client, fallback, security/RAG settings, knowledge-base index directory, bound address, and `mcp_clients` (live upstream MCP client tasks).
- `provider::adapter`: protocol-specific upstream URL, auth header, and request-body construction.
- `proxy::sse`: SSE streaming parser/accumulator; extracts usage and generated text for logging.
- `security`: risk levels (`Clean` to `Critical`), actions (`Allow`/`Warn`/`Redact`/`Block`), builtin/custom rules, scanner, and redaction.
- `knowledge`: chunking with tree-sitter, embedding via an upstream channel, usearch vector index on disk, retrieval, and RAG injection.
- `mcp`: Streamable HTTP MCP server exposing knowledge-base tools, protected by API-key auth.
- `mcp_client`: upstream MCP server *client* connections (stdio child-process + streamable-http), kept alive as background tasks in `AppState.mcp_clients`; a handle implies a completed handshake (connect awaits the handshake outcome).
- `commands`: Tauri invoke handlers wired in `lib.rs`; the frontend calls them through `src/lib/api.ts`. Feature-management modules: `prompt` (CLAUDE.md templates + enable-exclusive write-to-disk), `session` (request_logs grouped by `trace_id`), `mcp_server` (upstream MCP server CRUD + connect/test/disconnect), `skill` (skills library synced to `~/.claude/skills/<dir>/SKILL.md`).
- `cli_config`: writes Claude Code (`~/.claude/settings.json` + `~/.claude.json`) and Codex (`~/.codex/config.toml`) configuration so local CLI tools point at the gateway.

### Persistence

- Runtime data lives in SQLite (`app_data_dir/llm-gateway.db`). Schema migrations are in `src-tauri/migrations/` and applied on startup.
- Settings (security, RAG, fallback, preferred port) are persisted through `tauri-plugin-store` in `app_data_dir/store.bin`.
- Knowledge-base vector indexes are stored in `app_data_dir/kb/`.

### Testing notes

- Integration tests live in `src-tauri/tests/` and share mock upstream servers via `tests/common/mod.rs` (`spawn_mock`, `spawn_mock_with_embeddings`, `spawn_mock_stream`).
- Most integration tests create an in-memory `Db`, insert a channel/API key/role route, start the gateway with `server::start(state, 0)` to bind a random port, then call it over HTTP.
- `src-tauri/.cargo/config.toml` pins `RUST_TEST_THREADS=1` to avoid port/database conflicts.

### Frontend

- `src/App.tsx` defines the page routes; `src/components/Layout.tsx` is the chrome.
- Pages: Dashboard, Channels, API Keys, Role Routes, Security, Logs, Knowledge, Settings, Prompts, Sessions, MCP Servers, Skills.
- `src/lib/api.ts` is the typed wrapper around Tauri invoke commands; `src/types/index.ts` mirrors the Rust models.
- UI text is mostly in Chinese to match the original `cc-switch` style.

## Conventions worth knowing

- Channel model field `upstream_protocol` controls how the upstream request is built and authenticated. When adding a new protocol, update `provider::adapter`, `proxy::forwarder::try_channel`, and `proxy::forwarder::forward_stream`.
- New Tauri commands must be added to the `invoke_handler!` macro in `lib.rs` and to `src/lib/api.ts` before the frontend can call them.
- Request/response bodies written to logs are redacted via `security::redact::redact_json_for_logging`; raw API keys should never be stored in `request_logs`.
- The gateway `reqwest` client is built with `.no_proxy()` so local reverse proxies do not intercept loopback traffic.
