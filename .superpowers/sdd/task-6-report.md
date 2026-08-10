# Task 6 后端测试补强报告

## 变更摘要
- 新建：`src-tauri/tests/failover.rs`
- 修改：`src-tauri/src/db/repository.rs`（仅测试模块）
- 修改：`src-tauri/src/security/rules.rs`（仅测试模块）
- 修改：`src-tauri/tests/common/mod.rs`（添加 `#![allow(dead_code)]`）
- 生产代码逻辑/签名未改动。

## 新增测试清单

### `src-tauri/tests/failover.rs`（7 个）
| 测试名 | 覆盖内容 |
| --- | --- |
| `dispatch_primary_401_falls_back` | 主渠道 401 → 触发 failover，命中备渠道，主 success_rate 下降 |
| `dispatch_primary_403_falls_back` | 主渠道 403 → 触发 failover，命中备渠道，主 success_rate 下降 |
| `dispatch_primary_429_falls_back` | 主渠道 429 → 触发 failover，命中备渠道，主 success_rate 下降 |
| `dispatch_primary_500_falls_back` | 主渠道 500 → 触发 failover，命中备渠道，主 success_rate 下降 |
| `dispatch_primary_network_unreachable_falls_back` | 主渠道指向未监听端口（`http://127.0.0.1:1`）→ 网络不可达触发 failover |
| `dispatch_all_candidates_fail_returns_5xx` | 主/备全部失败 → 返回上游 5xx 错误，且两条渠道 success_rate 均下降 |
| `dispatch_primary_400_does_not_fallback` | 主渠道 400（非 failover 4xx）→ 不触发 failover，备渠道未被命中 |

说明：本文件采用**普通调度路径**（`role_route = None`），与 `tests/forward_failover.rs` 的角色路由+兜底路径不重复。`forward_failover.rs` 已覆盖 5xx/400，本文件补全 401/403/429/网络不可达/全失败，并额外验证 `record_channel_stats` 的副作用。

### `src-tauri/src/db/repository.rs` 测试模块（4 个）
| 测试名 | 覆盖内容 |
| --- | --- |
| `consume_quota_zero_tokens_increments_calls_without_changing_used` | 零 token 消耗：调用次数 +1，quota_used 不变 |
| `consume_quota_large_value_and_over_cap_is_atomic` | 大值消费后再次大额请求超额，原子性拒绝且 used 不扣减 |
| `consume_quota_over_cap_does_not_decrement` | 已用接近上限时超额请求返回 false，且 quota_used/total_calls/total_tokens 均不变 |
| `record_channel_stats_sliding_window_updates_avg_and_success_rate` | 多次调用后 `avg_latency_ms` 与 `success_rate` 滑动窗口值按预期变化 |

### `src-tauri/src/security/rules.rs` 测试模块（2 个）
| 测试名 | 覆盖内容 |
| --- | --- |
| `custom_blacklist_case_insensitive_and_evidence_masked` | 黑名单关键字大小写不敏感命中，且 `evidence_masked` 含 `****`、不含原文 |
| `custom_rules_append_not_replace` | `findings` 预存一条记录，调用后长度 +1，确认 append 语义 |

## stream=true 非流式 collect 路径
经检查 `src-tauri/src/proxy/handlers.rs`：`chat.stream == true` 直接走 `handle_stream` -> `forwarder::forward_stream`；`forwarder::forward` 内部仅按 `chat.stream` 构造上游 URL，不存在把 stream 请求当作非流式聚合返回完整响应的独立路径。**该路径不存在，故跳过，未 invent。**

## 验证结果

### Build
```
cargo build --manifest-path src-tauri/Cargo.toml
   Compiling llm-gateway v0.1.0
    Finished `dev` profile [unoptimized + debuginfo] target(s)
```
干净，无错误。

### Tests
基线：143 个测试通过（116 unit + 27 integration）。
完成后：156 个测试通过（122 unit + 34 integration）。

```
test result: ok. 122 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (failover)
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (forward_failover)
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (gateway_e2e)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (security_request)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (security_response)
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (security_stream)
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out   (stream_e2e)
```

### Warnings
- 变更前：`cargo test ... | grep -ci warning` = **8**
- 变更后：`cargo test ... | grep -ci warning` = **0**

`tests/common/mod.rs` 的 `MockUpstream` 未用字段与 `spawn_mock`/`spawn_mock_stream` 未用告警已通过 `#![allow(dead_code)]` 消除。

## 生产 Bug / 关注点
未发现生产 bug。所有新增测试均为边界/分支覆盖，未修改生产逻辑。

## 自检项
- [x] 每个新测试都有有意义断言，无空断言测试。
- [x] failover 分支未与 `forward_failover.rs` 重复。
- [x] 未修改生产代码（`git diff src/` 仅在 repository.rs/rules.rs 的 `#[cfg(test)]` 模块内）。
- [x] 未使用真实 api_key，测试 key 均为 `sk-lgw-*` / `sk-test` 等 fixture。
- [x] 未使用固定端口，全部使用 `spawn_mock` 绑定 ephemeral port；网络不可达测试使用 `127.0.0.1:1`。
- [x] 构建通过、全部测试绿色、无新增 warning。
