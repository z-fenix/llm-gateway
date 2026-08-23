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
    readCliConfig: vi.fn().mockResolvedValue('{"env":{"A":"1"}}'),
    writeCliConfigContent: vi.fn().mockResolvedValue({
      path: "~/.claude/settings.json",
      changed_keys: ["env.A"],
      backup_path: null,
      env_instructions: null,
    }),
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

  it("点击编辑配置读取 readCliConfig 并填充 textarea", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    await waitFor(() =>
      expect(mockedApi.readCliConfig).toHaveBeenCalledWith("claude_code")
    );
    const textarea = await screen.findByLabelText("CLI 配置 JSON");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue('{"env":{"A":"1"}}');
  });

  it("输入非法 JSON 显示 JSON 格式错误", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    const textarea = await screen.findByLabelText("CLI 配置 JSON");
    fireEvent.change(textarea, { target: { value: "{bad" } });
    expect(screen.getByText("JSON 格式错误")).toBeInTheDocument();
  });

  it("格式化按钮将压缩 JSON 美化", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    const textarea = await screen.findByLabelText("CLI 配置 JSON");
    fireEvent.change(textarea, { target: { value: '{"env":{"A":"1"}}' } });
    fireEvent.click(screen.getByRole("button", { name: "格式化" }));
    expect(textarea).toHaveValue('{\n  "env": {\n    "A": "1"\n  }\n}');
  });

  it("保存调用 writeCliConfigContent(target, cliJson)", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    const textarea = await screen.findByLabelText("CLI 配置 JSON");
    fireEvent.change(textarea, { target: { value: '{"env":{"A":"2"}}' } });
    fireEvent.click(screen.getByRole("button", { name: "保存 CLI 配置" }));
    await waitFor(() =>
      expect(mockedApi.writeCliConfigContent).toHaveBeenCalledWith(
        "claude_code",
        '{"env":{"A":"2"}}'
      )
    );
  });

  it("Codex 目标编辑器显示 config.toml 提示", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "目标 CLI" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("combobox", { name: "目标 CLI" }));
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    await waitFor(() =>
      expect(mockedApi.readCliConfig).toHaveBeenCalledWith("codex")
    );
    expect(
      await screen.findByText("config.toml（将转为 JSON 编辑）")
    ).toBeInTheDocument();
  });
});
