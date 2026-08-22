import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ApiKeysPage from "../ApiKeysPage";
import { api } from "../../lib/api";
import type { ApiKey } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    setApiKeyEnabled: vi.fn().mockResolvedValue(undefined),
    deleteApiKey: vi.fn().mockResolvedValue(undefined),
    updateApiKey: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

const key = (id: string, overrides: Partial<ApiKey> = {}): ApiKey => ({
  id,
  key: `sk-lgw-${id}`,
  name: `key${id}`,
  enabled: true,
  quota_total: null,
  quota_used: 0,
  total_calls: 0,
  total_tokens: 0,
  created_at: 1,
  last_used_at: null,
  ...overrides,
});

describe("ApiKeysPage 生成密钥", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listApiKeys.mockResolvedValue([]);
    mockedApi.createApiKey.mockResolvedValue(key("k1"));
    mockedApi.setApiKeyEnabled.mockResolvedValue(undefined);
    mockedApi.deleteApiKey.mockResolvedValue(undefined);
    mockedApi.updateApiKey.mockResolvedValue(undefined);
  });

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

  it("空列表展示空状态与创建引导", async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("暂无密钥")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "新建密钥" })
    ).toBeInTheDocument();
  });

  it("列表渲染状态徽标与启用/禁用切换", async () => {
    mockedApi.listApiKeys.mockResolvedValue([
      key("k1", { name: "alice", enabled: true }),
      key("k2", { name: "bob", enabled: false }),
    ]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    // 两个密钥分别有启用/禁用状态徽标
    expect(screen.getAllByText("启用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("禁用").length).toBeGreaterThan(0);

    // k1 的启用开关（按钮文本为“禁用”）→ 调 setApiKeyEnabled(id, false)
    fireEvent.click(screen.getAllByRole("button", { name: "禁用" })[0]);
    await waitFor(() =>
      expect(api.setApiKeyEnabled).toHaveBeenCalledWith("k1", false)
    );
  });

  it("复制按钮写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockedApi.listApiKeys.mockResolvedValue([key("k1")]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("sk-lgw-k1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-lgw-k1"));
  });

  it("编辑对话框预填并调用 updateApiKey 同时改名与配额", async () => {
    mockedApi.listApiKeys.mockResolvedValue([
      key("k1", { name: "alice", quota_total: 100 }),
    ]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      await screen.findByRole("heading", { name: "编辑密钥" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("alice"), {
      target: { value: "alice2" },
    });
    fireEvent.change(screen.getByDisplayValue("100"), {
      target: { value: "200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith("k1", "alice2", 200)
    );
  });

  it("删除密钥走确认对话框并调用 deleteApiKey", async () => {
    mockedApi.listApiKeys.mockResolvedValue([key("k1")]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("sk-lgw-k1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除密钥" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.deleteApiKey).toHaveBeenCalledWith("k1")
    );
  });
});
