import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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

    fireEvent.click(screen.getByRole("button", { name: "创建密钥" }));
    const btn = screen.getByRole("button", { name: "生成密钥" });
    // 空名称时按钮应禁用，给出明确的不可点击信号而不是“点了没反应”
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it("填写名称后按钮可用并调用创建", async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(api.listApiKeys).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "创建密钥" }));
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
    expect(screen.getByRole("switch", { name: "启用 alice" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "启用 bob" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "启用 alice" }));
    await waitFor(() =>
      expect(api.setApiKeyEnabled).toHaveBeenCalledWith("k1", false)
    );
  });

  it("密钥默认隐藏，可显式查看后再次隐藏", async () => {
    mockedApi.listApiKeys.mockResolvedValue([key("k1")]);
    render(<ApiKeysPage />);
    await screen.findByText("keyk1");
    expect(screen.queryByText("sk-lgw-k1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理密钥" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 keyk1 密钥" }));
    expect(screen.getByText("sk-lgw-k1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "隐藏 keyk1 密钥" }));
    expect(screen.queryByText("sk-lgw-k1")).not.toBeInTheDocument();
  });

  it("掩码保留真实密钥前缀，不伪造设计示例中的前缀", async () => {
    mockedApi.listApiKeys.mockResolvedValue([key("k1", { key: "sk-lgw-synthetic-value-a7f2" })]);
    render(<ApiKeysPage />);
    expect(await screen.findByText("sk-lgw-••••••••a7f2")).toBeInTheDocument();
    expect(screen.queryByText("sk-lgw-synthetic-value-a7f2")).not.toBeInTheDocument();
  });

  it("复制按钮写入剪贴板", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockedApi.listApiKeys.mockResolvedValue([key("k1")]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("keyk1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "管理密钥" }));
    fireEvent.click(screen.getByRole("button", { name: "复制密钥" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-lgw-k1"));
  });

  it("编辑对话框预填并调用 updateApiKey 同时改名与配额", async () => {
    mockedApi.listApiKeys.mockResolvedValue([
      key("k1", { name: "alice", quota_total: 100 }),
    ]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "管理密钥" }));
    expect(
      await screen.findByRole("heading", { name: "管理密钥" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("100")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("alice"), {
      target: { value: "alice2" },
    });
    fireEvent.change(screen.getByDisplayValue("100"), {
      target: { value: "200" },
    });
    // DSH 改造后页脚按钮为「应用」（FormFooter 默认），旧断言「保存」属于本次修正
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith("k1", "alice2", 200)
    );
  });

  it("删除密钥走确认对话框并调用 deleteApiKey", async () => {
    mockedApi.listApiKeys.mockResolvedValue([key("k1")]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("keyk1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "管理密钥" }));
    fireEvent.click(screen.getByRole("button", { name: "删除密钥" }));
    expect(
      await screen.findByRole("heading", { name: "删除密钥" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.deleteApiKey).toHaveBeenCalledWith("k1")
    );
  });

  it("创建卡 pristine 生成密钥禁用无行内错误；配额非法失焦出现行内错误仍禁用，修正后恢复", async () => {
    render(<ApiKeysPage />);
    await waitFor(() => expect(api.listApiKeys).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "创建密钥" }));
    // Pristine 仅禁用提交，不显示尚未触碰字段的错误。
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("用户/应用名"), {
      target: { value: "my-app" },
    });
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Token 配额"), {
      target: { value: "-1" },
    });
    fireEvent.blur(screen.getByLabelText("Token 配额"));
    expect(screen.getByText("请输入非负整数或有效单位，如 1.5M（不超过安全整数）")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Token 配额"), {
      target: { value: "100" },
    });
    expect(screen.getByRole("button", { name: "生成密钥" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("编辑对话框：清空名称失焦出现行内错误且应用禁用，补全后恢复", async () => {
    mockedApi.listApiKeys.mockResolvedValue([
      key("k1", { name: "alice", quota_total: 100 }),
    ]);
    render(<ApiKeysPage />);
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "管理密钥" }));
    expect(
      await screen.findByRole("heading", { name: "管理密钥" })
    ).toBeInTheDocument();

    // 卡片与弹框各有「名称」字段，用 within(dialog) 限定弹框内查询
    const dialog = within(screen.getByRole("dialog"));
    const nameInput = dialog.getByDisplayValue("alice");
    fireEvent.change(nameInput, { target: { value: "" } });
    fireEvent.blur(nameInput);
    expect(dialog.getByText("名称不能为空")).toHaveAttribute("role", "alert");
    expect(dialog.getByRole("button", { name: "应用" })).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "alice2" } });
    expect(dialog.getByRole("button", { name: "应用" })).toBeEnabled();
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });
});
