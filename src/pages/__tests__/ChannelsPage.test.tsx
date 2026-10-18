import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
// Vite ?raw 导入：编译期把页面源码读成字符串，等价于 Task 10 的 node:fs 源码守卫
// （项目未装 @types/node，故不用 node:fs）
import channelsPageSource from "../ChannelsPage.tsx?raw";
import ChannelsPage, { STATUS_OPTIONS } from "../ChannelsPage";
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
    fireEvent.change(screen.getByLabelText(/^Base URL/), { target: { value: "https://api.deepseek.com" } });
    // DSH 改造后密钥为 SecretInput（write-only，无 placeholder），用 aria-label 定位；
    // 旧断言 getByPlaceholderText("真实上游 API Key") 钉在旧布局上，属于本次修正
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /添加模型/ }));
    const modelInputs = screen.getAllByPlaceholderText(/输入或选择模型/);
    fireEvent.change(modelInputs[modelInputs.length - 1], { target: { value: "deepseek-chat" } });
    fireEvent.change(screen.getByLabelText("超时秒数"), { target: { value: "60" } });

    // DSH 改造后页脚按钮为「应用」（FormFooter 默认），旧断言 getByText("保存") 属于本次修正
    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(mockedApi.createChannel).toHaveBeenCalled());
    expect(mockedApi.createChannel.mock.calls[0][0].name).toBe("新渠道");
    await waitFor(() => expect(mockedApi.listChannels).toHaveBeenCalledTimes(2));
  });

  it("编辑渠道：打开对话框并加载模型映射", async () => {
    // 编辑态夹具携带后端打码哨兵 api_key（list_channels 返回形态）
    mockedApi.listChannels.mockResolvedValue([channel("c1", { api_key: "sk-***test" })]);
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

  it("列表渲染状态点与已停用标签（Task 8 改版语义）", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", { enabled: true, avg_latency_ms: 87 }),
      channel("c2", { enabled: false, name: "禁用渠道" }),
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    const enabledCard = screen.getByText("渠道c1").closest(".group") as HTMLElement;
    expect(enabledCard.querySelector(".bg-success")).not.toBeNull();
    expect(enabledCard.textContent).toContain("87ms");

    const disabledCard = screen.getByText("禁用渠道").closest(".group") as HTMLElement;
    expect(disabledCard.textContent).toContain("已停用");
    expect(disabledCard.className).toContain("opacity-55");

    fireEvent.click(screen.getAllByRole("button", { name: "连通检测" })[0]);
    await waitFor(() => expect(mockedApi.testChannel).toHaveBeenCalledWith("c1"));
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
    mockedApi.listChannels.mockResolvedValue([channel("c1", { api_key: "sk-***test" })]);
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

describe("ChannelsPage 渠道页改版（Task 8）", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedApi.listChannels.mockResolvedValue([]);
    mockedApi.testChannel.mockResolvedValue({ ok: true, latency_ms: 120, error: null });
  });

  it("启用卡渲染 success 状态点与 text-success 等宽延迟（avg_latency_ms 常驻）", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", { enabled: true, avg_latency_ms: 87 }),
    ]);
    const { container } = render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    const card = screen.getByText("渠道c1").closest(".group") as HTMLElement;
    const dot = card.querySelector(".bg-success");
    expect(dot).not.toBeNull();
    const latency = card.querySelector(".text-success.font-mono");
    expect(latency).not.toBeNull();
    expect(latency?.textContent).toContain("87");
    // 延迟常驻：文本由令牌上色而非旧统计行的 muted 文案
    expect(container.querySelector(".hover\\:border-primary\\/40")).not.toBeNull();
  });

  it("连通检测后延迟更新为实测值并保持 text-success font-mono", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", { enabled: true, avg_latency_ms: 0 }),
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    // 未有实测延迟且 avg 为 0 时不渲染延迟
    const card = screen.getByText("渠道c1").closest(".group") as HTMLElement;
    expect(card.querySelector(".text-success.font-mono")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "连通检测" }));
    await waitFor(() => {
      const latency = card.querySelector(".text-success.font-mono");
      expect(latency?.textContent).toContain("120");
    });
  });

  it("停用卡渲染 已停用 标签且卡片 opacity-55，无 success 点", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c2", { enabled: false, name: "停用渠道" }),
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("停用渠道")).toBeInTheDocument());

    const card = screen.getByText("停用渠道").closest(".group") as HTMLElement;
    expect(card.className).toContain("opacity-55");
    expect(card.textContent).toContain("已停用");
    expect(card.querySelector(".bg-success")).toBeNull();
  });

  it("页面源码不含 border-border-active 死类与 bg-gradient-to-* 渐变类", () => {
    expect(channelsPageSource).not.toContain("border-border-active");
    expect(channelsPageSource).not.toMatch(/bg-gradient-to-/);
  });

  it("状态筛选使用 SegmentedTabs：tablist 选项数与 STATUS_OPTIONS 一致，all 语义往返", async () => {
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", { enabled: true }),
      channel("c2", { enabled: false, name: "停用渠道" }),
    ]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("渠道c1")).toBeInTheDocument());

    const tablist = screen.getByRole("tablist", { name: "渠道状态筛选" });
    const tabs = Array.from(tablist.querySelectorAll("[role='tab']"));
    expect(tabs.length).toBe(STATUS_OPTIONS.length);
    expect(tabs.map((t) => t.textContent)).toEqual(
      STATUS_OPTIONS.map((o) => o.label)
    );

    // 初始 全部：两张卡都在
    expect(screen.getByText("渠道c1")).toBeInTheDocument();
    expect(screen.getByText("停用渠道")).toBeInTheDocument();

    // 切到 启用：只留启用卡
    fireEvent.click(screen.getByRole("tab", { name: "启用" }));
    await waitFor(() => expect(screen.queryByText("停用渠道")).not.toBeInTheDocument());
    expect(screen.getByText("渠道c1")).toBeInTheDocument();

    // 切回 全部（"all" 值语义往返）
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    await waitFor(() => expect(screen.getByText("停用渠道")).toBeInTheDocument());
    expect(screen.getByText("渠道c1")).toBeInTheDocument();
  });
});

describe("ChannelsPage 渠道表单 DSH 改造（Task 2）", () => {
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

  async function openCreateDialog() {
    const { container } = render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText("暂无渠道")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "新建渠道" })[0]);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新建渠道" })).toBeInTheDocument()
    );
    return { container };
  }

  async function openEditDialog(fixture: Channel) {
    mockedApi.listChannels.mockResolvedValue([fixture]);
    render(<ChannelsPage />);
    await waitFor(() => expect(screen.getByText(fixture.name)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "编辑渠道" })).toBeInTheDocument()
    );
  }

  /** 填写一个能通过校验的新建表单（名称/Base URL/Key/一个模型）。 */
  function fillCreateForm() {
    fireEvent.change(screen.getByPlaceholderText("名称"), { target: { value: "新渠道" } });
    fireEvent.change(screen.getByLabelText(/^Base URL/), { target: { value: "https://api.deepseek.com" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /添加模型/ }));
    const modelInputs = screen.getAllByPlaceholderText(/输入或选择模型/);
    fireEvent.change(modelInputs[modelInputs.length - 1], { target: { value: "deepseek-chat" } });
  }

  it("折叠区「自定义设置」存在且默认收起（details 无 open 属性）", async () => {
    await openCreateDialog();

    // Radix Dialog 传送到 body，从 summary 语义反查 details
    const details = screen.getByText("自定义设置").closest("details");
    expect(details).not.toBeNull();
    expect(details!.querySelector("summary")?.textContent).toContain("自定义设置");
    expect(details!.hasAttribute("open")).toBe(false);
    // 折叠字段仍在 DOM（收起仅视觉隐藏）：上游协议 / 优先级 / 权重 / 超时秒数
    expect(screen.getByText("上游协议")).toBeInTheDocument();
    expect(screen.getByLabelText("优先级")).toBeInTheDocument();
    expect(screen.getByLabelText("权重")).toBeInTheDocument();
    expect(screen.getByLabelText("超时秒数")).toBeInTheDocument();
  });

  it("必填缺失：pristine 无行内错误但应用禁用；触碰名称后行内错误出现；补全后恢复可用", async () => {
    await openCreateDialog();

    // pristine：不喊错（无 role=alert），仅应用禁用
    const apply = screen.getByRole("button", { name: "应用" });
    expect(apply).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // 触碰名称（blur）→ 行内错误出现
    fireEvent.blur(screen.getByPlaceholderText("名称"));
    expect(screen.getByText("名称不能为空")).toHaveAttribute("role", "alert");

    // 补全全部必填后恢复可用
    fillCreateForm();
    await waitFor(() => expect(apply).toBeEnabled());
  });

  it("编辑态 key 留空提交：updateChannel payload 的 api_key 为原掩码值", async () => {
    await openEditDialog(channel("c1", { api_key: "sk-***test" }));

    // 密钥不回填：输入框为空，placeholder 提示已保存
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toBe("已保存，留空保持不变");

    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(mockedApi.updateChannel).toHaveBeenCalledTimes(1));
    const payload = mockedApi.updateChannel.mock.calls[0][0];
    expect(payload.api_key).toBe("sk-***test");
    expect(payload.id).toBe("c1");
  });

  it("busy 提交中：应用文案切换为「应用中」且取消禁用，完成后恢复关闭", async () => {
    await openCreateDialog();
    fillCreateForm();

    let resolveCreate!: (v: Channel) => void;
    mockedApi.createChannel.mockImplementationOnce(
      () => new Promise<Channel>((res) => { resolveCreate = res; })
    );

    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(screen.getByRole("button", { name: "应用中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    resolveCreate(channel("c-new"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "应用中" })).not.toBeInTheDocument()
    );
  });
});
