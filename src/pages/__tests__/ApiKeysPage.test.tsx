import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ApiKeysPage from "../ApiKeysPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    listApiKeys: vi.fn().mockResolvedValue([]),
    createApiKey: vi.fn().mockResolvedValue({
      id: "k1",
      key: "sk-lgw-x",
      name: "test",
      enabled: true,
      quota_total: null,
      quota_used: 0,
      total_calls: 0,
      total_tokens: 0,
      created_at: 1,
      last_used_at: null,
    }),
    setApiKeyEnabled: vi.fn().mockResolvedValue(undefined),
    deleteApiKey: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("ApiKeysPage 生成密钥", () => {
  beforeEach(() => vi.clearAllMocks());

  it("名称为空时按钮禁用，点击不产生任何调用（修复“无响应”）", async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(api.listApiKeys).toHaveBeenCalled());

    const btn = screen.getByRole("button", { name: "生成密钥" });
    // 空名称时按钮应禁用，给出明确的不可点击信号而不是“点了没反应”
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it("填写名称后按钮可用并调用创建", async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(api.listApiKeys).toHaveBeenCalled());

    const btn = screen.getByRole("button", { name: "生成密钥" });
    fireEvent.change(screen.getByPlaceholderText("用户/应用名"), {
      target: { value: "my-app" },
    });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.createApiKey).toHaveBeenCalledWith("my-app", null)
    );
  });
});
