import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SettingsPage from "../SettingsPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    getAppConfig: vi
      .fn()
      .mockResolvedValue({ preferred_port: 8777, bound_addr: "127.0.0.1:8777" }),
    setPreferredPort: vi.fn().mockResolvedValue(undefined),
    restartGateway: vi.fn().mockResolvedValue(undefined),
    getCliTargets: vi.fn().mockResolvedValue([
      {
        target: "claude_code",
        configured: true,
        path: "~/.claude/settings.json",
      },
      { target: "codex", configured: false, path: "~/.codex/config.toml" },
    ]),
    writeCliConfig: vi.fn().mockResolvedValue([]),
    listApiKeys: vi.fn().mockResolvedValue([{ id: "k1", name: "默认密钥" }]),
    defaultExportPath: vi.fn().mockResolvedValue("C:/export.json"),
    exportConfig: vi.fn().mockResolvedValue(100),
    previewImport: vi.fn().mockResolvedValue({
      channels: 1,
      api_keys: 1,
      role_routes: 0,
      role_patterns: 0,
      custom_rules: 0,
      conflicts: 0,
    }),
    importConfig: vi.fn().mockResolvedValue({
      imported: 1,
      skipped: 0,
      overwritten: 0,
    }),
    getRectifierConfig: vi.fn().mockResolvedValue({
      enabled: true,
      request_thinking_signature: true,
      request_thinking_budget: true,
      request_media_fallback: true,
      request_media_heuristic: true,
    }),
    setRectifierConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染各分组卡片", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("端口配置")).toBeInTheDocument()
    );
    expect(screen.getByText("CLI 一键写入")).toBeInTheDocument();
    expect(screen.getByText("导出配置")).toBeInTheDocument();
    expect(screen.getByText("导入配置")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:8777")).toBeInTheDocument();
  });

  it("CLI target 下拉显示友好标签", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "目标 CLI" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("combobox", { name: "目标 CLI" }));
    expect(await screen.findByRole("option", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).toBeInTheDocument();
  });

  it("切换 target 后一键写入调用 writeCliConfig(target, apiKeyId, writeEnv)", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "目标 CLI" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("combobox", { name: "目标 CLI" }));
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "一键写入" }));
    await waitFor(() =>
      expect(mockedApi.writeCliConfig).toHaveBeenCalledWith("codex", "k1", true)
    );
  });

  it("保存端口调用 setPreferredPort", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("首选端口")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByLabelText("首选端口"), {
      target: { value: "8780" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedApi.setPreferredPort).toHaveBeenCalledWith(8780)
    );
  });

  it("端口保存后显示立即重启按钮，点击调用 restartGateway", async () => {
    mockedApi.getAppConfig.mockResolvedValue({
      preferred_port: 8777,
      bound_addr: "127.0.0.1:8777",
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("首选端口")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedApi.setPreferredPort).toHaveBeenCalled()
    );
    fireEvent.click(screen.getByRole("button", { name: "立即重启" }));
    await waitFor(() => expect(mockedApi.restartGateway).toHaveBeenCalled());
  });

  it("整流器卡片渲染并显示子开关文案", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("整流器")).toBeInTheDocument()
    );
    expect(
      screen.getByText("修复 thinking signature 错误")
    ).toBeInTheDocument();
    expect(screen.getByText("修复 thinking budget 错误")).toBeInTheDocument();
    expect(screen.getByText("图片降级（总开关）")).toBeInTheDocument();
  });

  it("点击启用整流器开关调用 setRectifierConfig('enabled', false)", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "启用整流器" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("switch", { name: "启用整流器" }));
    await waitFor(() =>
      expect(mockedApi.setRectifierConfig).toHaveBeenCalledWith("enabled", false)
    );
  });
});
