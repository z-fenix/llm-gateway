import { vi, describe, it, expect, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

// Tauri v2 的 #[tauri::command] 默认按 camelCase 匹配参数键
// （tauri-macros ArgumentCase::Camel）。这些测试锁定前端 invoke 的
// 顶层入参键必须与后端 snake_case 参数的 lowerCamelCase 形式一致，
// 防止回归成 snake_case（会导致非 Option 参数报 missing required key，
// Option 参数被静默丢成 None）。
describe("api invoke 参数键（camelCase 契约）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createApiKey → quotaTotal", async () => {
    await api.createApiKey("n", 5);
    expect(invoke).toHaveBeenCalledWith("create_api_key", { name: "n", quotaTotal: 5 });
  });

  it("updateQuota → quotaTotal", async () => {
    await api.updateQuota("id1", 100);
    expect(invoke).toHaveBeenCalledWith("update_quota", { id: "id1", quotaTotal: 100 });
  });

  it("setRoleRoute → channelId/targetModel", async () => {
    await api.setRoleRoute("r", "cid", "m");
    expect(invoke).toHaveBeenCalledWith("set_role_route", {
      role: "r",
      channelId: "cid",
      targetModel: "m",
    });
  });

  it("setFallback → channelId", async () => {
    await api.setFallback("cid", "m");
    expect(invoke).toHaveBeenCalledWith("set_fallback", { channelId: "cid", model: "m" });
  });

  it("createCustomSecurityRule → ruleType", async () => {
    await api.createCustomSecurityRule("blacklist", "keyword", "p", "high", "block", "d");
    expect(invoke).toHaveBeenCalledWith("create_custom_security_rule", {
      ruleType: "blacklist",
      category: "keyword",
      pattern: "p",
      severity: "high",
      action: "block",
      description: "d",
    });
  });

  it("getSecurityFindings → logId", async () => {
    await api.getSecurityFindings("l1");
    expect(invoke).toHaveBeenCalledWith("get_security_findings", { logId: "l1" });
  });

  it("createKb → embeddingChannelId/embeddingModel", async () => {
    await api.createKb("n", "d", "cid", "m");
    expect(invoke).toHaveBeenCalledWith("create_kb", {
      name: "n",
      description: "d",
      embeddingChannelId: "cid",
      embeddingModel: "m",
    });
  });

  it("uploadDocument → kbId/contentBase64", async () => {
    await api.uploadDocument("kb", "f", "b64");
    expect(invoke).toHaveBeenCalledWith("upload_document", {
      kbId: "kb",
      filename: "f",
      contentBase64: "b64",
    });
  });

  it("listDocuments → kbId", async () => {
    await api.listDocuments("kb");
    expect(invoke).toHaveBeenCalledWith("list_documents", { kbId: "kb" });
  });

  it("searchKb → kbId", async () => {
    await api.searchKb("kb", "q");
    expect(invoke).toHaveBeenCalledWith("search_kb", { kbId: "kb", query: "q" });
  });

  it("writeCliConfig → apiKeyId/writeEnv", async () => {
    await api.writeCliConfig("claude", "k1", true);
    expect(invoke).toHaveBeenCalledWith("write_cli_config", {
      target: "claude",
      apiKeyId: "k1",
      writeEnv: true,
    });
  });
});
