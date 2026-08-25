import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ChannelsPage from "../ChannelsPage";
import { api } from "../../lib/api";
import type { Channel } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listChannels: vi.fn(),
    createChannel: vi.fn().mockResolvedValue({ id: "c-new" }),
    updateChannel: vi.fn().mockResolvedValue(undefined),
    deleteChannel: vi.fn().mockResolvedValue(undefined),
    duplicateChannel: vi
      .fn()
      .mockResolvedValue({
        id: "c-new",
        name: "渠道c-new",
        supplier: "openai",
        upstream_protocol: "openai-chat",
        base_url: "https://api.openai.com",
        api_key: "sk-x",
        models: ["gpt-4o"],
        priority: 0,
        weight: 1,
        enabled: true,
        timeout_secs: 60,
        total_calls: 0,
        total_tokens: 0,
        success_rate: 0,
        avg_latency_ms: 0,
        created_at: 1,
        updated_at: 1,
      }),
    testChannel: vi.fn().mockResolvedValue({ ok: true, latency_ms: 120, error: null }),
    getModelMap: vi.fn().mockResolvedValue([]),
    setModelMap: vi.fn().mockResolvedValue(undefined),
    deleteModelMap: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

const channel = (id: string, overrides: Partial<Channel> = {}): Channel => ({
  id,
  name: `渠道${id}`,
  supplier: "openai",
  upstream_protocol: "openai-chat",
  base_url: "https://api.openai.com",
  api_key: "sk-x",
  models: ["gpt-4o"],
  priority: 0,
  weight: 1,
  enabled: true,
  timeout_secs: 60,
  total_calls: 0,
  total_tokens: 0,
  success_rate: 0,
  avg_latency_ms: 0,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

describe("ChannelsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedApi.listChannels.mockResolvedValue([]);
    mockedApi.createChannel.mockResolvedValue(channel("c-new"));
    mockedApi.updateChannel.mockResolvedValue(undefined);
    mockedApi.deleteChannel.mockResolvedValue(undefined);
    mockedApi.duplicateChannel.mockResolvedValue(channel("c-new"));
    mockedApi.testChannel.mockResolvedValue({ ok: true, latency_ms: 120, error: null });
    mockedApi.getModelMap.mockResolvedValue([]);
    mockedApi.setModelMap.mockResolvedValue(undefined);
    mockedApi.deleteModelMap.mockResolvedValue(undefined);
  });

  it("空列表展示空状态", async () => {
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("暂无渠道")).toBeInTheDocument());
    expect(screen.getByText("还没有配置任何上游渠道，先创建一个吧")).toBeInTheDocument();
  });

  it("新建渠道：对话框填写并保存调用 createChannel 并刷新列表", async () => {
    mockedApi.listChannels.mockResolvedValue([]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("暂无渠道")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "新建渠道" })[0]);
    expect(await screen.findByRole("heading", { name: "新建渠道" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("名称"), { target: { value: "新渠道" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.deepseek.com" } });
    fireEvent.change(screen.getByPlaceholderText("真实上游 API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /添加模型/ }));
    const modelInputs = screen.getAllByPlaceholderText(/模型 ID/);
    fireEvent.change(modelInputs[modelInputs.length - 1], { target: { value: "deepseek-chat" } });
    fireEvent.change(screen.getByLabelText("超时秒数"), { target: { value: "60" } });

    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(mockedApi.createChannel).toHaveBeenCalled());
    expect(mockedApi.createChannel.mock.calls[0][0].name).toBe("新渠道");
    await waitFor(() => expect(mockedApi.listChannels).toHaveBeenCalledTimes(2));
  });

  it("编辑渠道：打开对话框并加载模型映射", async () => {
    mockedApi.listChannels.mockResolvedValue([channel("c1")]);
    mockedApi.getModelMap.mockResolvedValue([
      { channel_id: "c1", source_model: "sonnet", target_model: "claude-sonnet-4-5" },
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑渠道" })).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.getModelMap).toHaveBeenCalledWith("c1"));
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
  });

  it("列表渲染状态徽标与测试按钮", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", { enabled: true }),
      channel("c2", { enabled: false, name: "禁用渠道" }),
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());
    expect(screen.getAllByText("启用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("禁用").length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "测试" })[0]);
    await waitFor(() => expect(mockedApi.testChannel).toHaveBeenCalledWith("c1"));
    expect(screen.getByText(/✓ 120ms/)).toBeInTheDocument();
  });

  it("删除渠道需经过确认弹窗：确认后才调用 deleteChannel 并刷新", async () => {
    mockedApi.listChannels.mockResolvedValue([channel("c1")]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    // 点击删除只打开确认弹窗，不直接删除
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/确定删除渠道「渠道c1」/)).toBeInTheDocument();
    expect(mockedApi.deleteChannel).not.toHaveBeenCalled();

    // 点“取消”关闭弹窗且不删除
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText(/确定删除渠道/)).not.toBeInTheDocument());
    expect(mockedApi.deleteChannel).not.toHaveBeenCalled();

    // 再次打开并确认删除
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(mockedApi.deleteChannel).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(mockedApi.listChannels).toHaveBeenCalledTimes(2));
  });

  it("编辑弹窗通过 onOpenChange 关闭（点 X）会清空 editing 状态", async () => {
    mockedApi.listChannels.mockResolvedValue([channel("c1")]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(await screen.findByRole("heading", { name: "编辑渠道" })).toBeInTheDocument();

    // 点击右上角 X（Radix 关闭按钮），走 onOpenChange(false)，editing 应被清空
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "编辑渠道" })).not.toBeInTheDocument());

    // 再次打开“新建渠道”，不应残留之前的编辑态
    fireEvent.click(screen.getAllByRole("button", { name: "新建渠道" })[0]);
    expect(await screen.findByRole("heading", { name: "新建渠道" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "编辑渠道" })).not.toBeInTheDocument();
  });
});
