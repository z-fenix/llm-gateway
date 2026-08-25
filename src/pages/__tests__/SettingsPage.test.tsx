import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SettingsPage from "../SettingsPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    getAppConfig: vi
      .fn()
      .mockResolvedValue({
        preferred_port: 8777,
        bound_addr: "127.0.0.1:8777",
        minimize_to_tray: true,
      }),
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
    readCliConfig: vi.fn().mockResolvedValue('{"env":{"A":"1"}}'),
    writeCliConfigContent: vi.fn().mockResolvedValue({
      path: "~/.claude/settings.json",
      changed_keys: ["env.A"],
      backup_path: null,
      env_instructions: null,
    }),
    mergeGatewayEnv: vi.fn().mockResolvedValue(
      '{"env":{"A":"1","ANTHROPIC_BASE_URL":"http://127.0.0.1:8777","ANTHROPIC_AUTH_TOKEN":"k1"}}'
    ),
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
    setMinimizeToTray: vi.fn().mockResolvedValue(undefined),
    listModelPrices: vi.fn().mockResolvedValue([]),
    upsertModelPrice: vi.fn().mockResolvedValue(null),
    deleteModelPrice: vi.fn().mockResolvedValue(null),
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
    expect(screen.getByText("CLI 配置")).toBeInTheDocument();
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
      minimize_to_tray: true,
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

  it("设置当前网关仅改写 env 变量并回填编辑框", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑配置" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    const textarea = await screen.findByLabelText("CLI 配置 JSON");

    // 选择 API 密钥并点击“设置当前网关”
    fireEvent.click(screen.getByRole("combobox", { name: "编辑器 API 密钥" }));
    fireEvent.click(await screen.findByRole("option", { name: "默认密钥" }));
    fireEvent.click(screen.getByRole("button", { name: "设置当前网关" }));

    await waitFor(() =>
      expect(mockedApi.mergeGatewayEnv).toHaveBeenCalledWith(
        '{"env":{"A":"1"}}',
        "k1"
      )
    );
    expect(textarea).toHaveValue(
      '{"env":{"A":"1","ANTHROPIC_BASE_URL":"http://127.0.0.1:8777","ANTHROPIC_AUTH_TOKEN":"k1"}}'
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

  it("关闭行为卡片渲染且默认开启，点击调用 setMinimizeToTray", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "关闭时最小化到托盘" })
      ).toBeInTheDocument()
    );
    const toggle = screen.getByRole("switch", { name: "关闭时最小化到托盘" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockedApi.setMinimizeToTray).toHaveBeenCalledWith(false)
    );
  });

  it("模型定价卡渲染列表与新增表单", async () => {
    mockedApi.listModelPrices.mockResolvedValue([
      {
        model_id: "claude-sonnet-4.5",
        display_name: "Claude Sonnet 4.5",
        input_cost_per_million: 3,
        output_cost_per_million: 15,
        cache_read_cost_per_million: 0.3,
        cache_creation_cost_per_million: 3.75,
        updated_at: 1700000000,
      },
    ]);
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("模型定价（估算费用）")).toBeInTheDocument()
    );
    expect(await screen.findByText("claude-sonnet-4.5")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(screen.getByLabelText("模型名")).toBeInTheDocument();
  });

  it("保存定价前归一化模型名并调用 upsertModelPrice", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("模型名")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("模型名"), {
      target: { value: "OpenRouter/Anthropic/Claude-Sonnet-4.5:free" },
    });
    fireEvent.change(screen.getByLabelText("显示名（可选）"), {
      target: { value: "Sonnet" },
    });
    fireEvent.change(screen.getByLabelText("输入($/M)"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("输出($/M)"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("缓存命中($/M)"), {
      target: { value: "0.3" },
    });
    fireEvent.change(screen.getByLabelText("缓存创建($/M)"), {
      target: { value: "3.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存定价" }));
    await waitFor(() => expect(mockedApi.upsertModelPrice).toHaveBeenCalledTimes(1));
    const arg = mockedApi.upsertModelPrice.mock.calls[0][0];
    expect(arg.model_id).toBe("anthropic/claude-sonnet-4.5");
    expect(arg.display_name).toBe("Sonnet");
    expect(arg.input_cost_per_million).toBe(3);
    expect(arg.cache_creation_cost_per_million).toBe(3.75);
  });

  it("Anthropic 参考按钮按 1.25x/0.1x 填充缓存价格", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("模型名")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("输入($/M)"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Anthropic 参考" }));
    expect(screen.getByLabelText("缓存创建($/M)")).toHaveValue(3.75);
    expect(screen.getByLabelText("缓存命中($/M)")).toHaveValue(0.3);
  });

  it("删除定价需确认并调用 deleteModelPrice", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockedApi.listModelPrices.mockResolvedValue([
      {
        model_id: "claude-sonnet-4.5",
        display_name: "Claude Sonnet 4.5",
        input_cost_per_million: 3,
        output_cost_per_million: 15,
        cache_read_cost_per_million: 0.3,
        cache_creation_cost_per_million: 3.75,
        updated_at: 1700000000,
      },
    ]);
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText("claude-sonnet-4.5")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(mockedApi.deleteModelPrice).toHaveBeenCalledWith("claude-sonnet-4.5")
    );
    confirmSpy.mockRestore();
  });
});
