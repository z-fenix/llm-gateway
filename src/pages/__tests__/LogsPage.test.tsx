import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import LogsPage from "../LogsPage";
import { api } from "../../lib/api";

vi.mock("../../components/LogTrendChart", () => ({
  default: function LogTrendChartMock(props: { dimension: string; bucketSecs: number }) {
    return <div data-testid="trend-chart" data-dimension={props.dimension} data-bucket-secs={props.bucketSecs}>chart</div>;
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    listChannels: vi.fn().mockResolvedValue([]),
    listApiKeys: vi.fn().mockResolvedValue([]),
    listLogs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getLogStats: vi.fn().mockResolvedValue({
      total_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      success_count: 0,
      risk_distribution: [],
      top_channels: [],
      top_api_keys: [],
    }),
    getLogTimeseries: vi.fn().mockResolvedValue([]),
    deleteLogsBefore: vi.fn().mockResolvedValue(0),
    clearLogs: vi.fn().mockResolvedValue(0),
    getLogRetentionDays: vi.fn().mockResolvedValue(30),
    setLogRetentionDays: vi.fn().mockResolvedValue(undefined),
    getSecurityFindings: vi.fn().mockResolvedValue([]),
  },
}));

const mockedApi = vi.mocked(api);

const makeLog = (over: Partial<any>): any => ({
  id: "l1",
  seq: 1,
  trace_id: "trace-abc",
  api_key_id: null,
  key_name: "key",
  channel_id: null,
  channel_name: "ch",
  role: "sonnet",
  request_model: "model-a",
  upstream_model: "model-b",
  protocol: "openai",
  status_code: 200,
  input_tokens: 10,
  output_tokens: 5,
  latency_ms: 100,
  is_stream: false,
  error: null,
  fallback: false,
  tool_calls: null,
  request_body: null,
  response_body: null,
  risk_level: "clean",
  risk_score: 0,
  risk_summary: null,
  security_action: "allow",
  sanitized: false,
  blocked_reason: null,
  created_at: 1700000000,
  ...over,
});

describe("LogsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filter bar 变更触发 listLogs/getLogStats/getLogTimeseries 联动", async () => {
    mockedApi.listChannels.mockResolvedValue([
      { id: "c1", name: "Channel A" } as any,
    ]);
    mockedApi.listApiKeys.mockResolvedValue([
      { id: "k1", name: "Key A" } as any,
    ]);

    render(<LogsPage />);
    await waitFor(() => expect(mockedApi.listChannels).toHaveBeenCalled());

    const keywordInput = screen.getByPlaceholderText("搜索 模型/渠道/TraceID/密钥");
    fireEvent.change(keywordInput, { target: { value: "foo" } });

    fireEvent.click(screen.getByText("查询"));

    await waitFor(() => {
      expect(mockedApi.listLogs).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: "foo", limit: 20, offset: 0 })
      );
      expect(mockedApi.getLogStats).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: "foo" })
      );
      expect(mockedApi.getLogTimeseries).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: "foo" }),
        expect.any(Number)
      );
    });
  });

  it("角色筛选下拉包含 auto 选项", async () => {
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText("全部角色")).toBeInTheDocument()
    );

    const roleSelect = screen.getByText("全部角色").closest("select")!;
    expect(within(roleSelect).getByRole("option", { name: "auto" })).toBeInTheDocument();
  });

  it("统计卡片渲染聚合数据", async () => {
    mockedApi.getLogStats.mockResolvedValue({
      total_calls: 128,
      total_input_tokens: 1000,
      total_output_tokens: 500,
      success_count: 100,
      risk_distribution: [["high", 10]],
      top_channels: [["Channel A", 50]],
      top_api_keys: [["Key A", 40]],
    });

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("128")).toBeInTheDocument());
    expect(screen.getByText(/1,?500/)).toBeInTheDocument();
    expect(screen.getByText(/78\.1%/)).toBeInTheDocument();
    expect(screen.getByText("high: 10")).toBeInTheDocument();
  });

  it("趋势面板 4 tab 切换 dimension", async () => {
    mockedApi.getLogTimeseries.mockResolvedValue([
      {
        bucket: 1,
        calls: 10,
        input_tokens: 5,
        output_tokens: 5,
        error_count: 0,
        risk_counts: {},
      },
    ]);

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeInTheDocument());
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-dimension", "calls");
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400");

    fireEvent.click(screen.getByRole("tab", { name: "Token" }));
    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-dimension", "tokens")
    );

    fireEvent.click(screen.getByRole("tab", { name: "成功率" }));
    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-dimension", "success")
    );

    fireEvent.click(screen.getByRole("tab", { name: "风险分布" }));
    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-dimension", "risk")
    );
  });

  it("挂载时仅请求一次 listLogs，不重复请求", async () => {
    render(<LogsPage />);
    await waitFor(() => expect(mockedApi.listChannels).toHaveBeenCalled());
    expect(mockedApi.listLogs).toHaveBeenCalledTimes(1);
    expect(mockedApi.getLogStats).toHaveBeenCalledTimes(1);
    expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(1);
  });

  it("时间跨度 ≤48h 时 bucketSecs 为 3600，否则为 86400", async () => {
    render(<LogsPage />);
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeInTheDocument());
    // 默认 7d(>48h) → 按天
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400");

    // 打开选择器,选 1d(≤48h) → 3600
    fireEvent.click(screen.getByRole("button", { name: /7d/ }));
    fireEvent.click(await screen.findByRole("button", { name: "1d" }));
    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "3600")
    );

    // 打开选择器,选 7d(>48h) → 86400
    fireEvent.click(screen.getByRole("button", { name: /1d/ }));
    fireEvent.click(await screen.findByRole("button", { name: "7d" }));
    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400")
    );
  });

  it("默认 7d 范围:listLogs 携带 after/before 且跨度约 7 天", async () => {
    render(<LogsPage />);
    await waitFor(() => expect(mockedApi.listLogs).toHaveBeenCalled());
    const call = mockedApi.listLogs.mock.calls[0][0];
    expect(call.after).toBeDefined();
    expect(call.before).toBeDefined();
    expect(call.before! - call.after!).toBeGreaterThan(6 * 86400);
    expect(call.before! - call.after!).toBeLessThan(7 * 86400 + 3600);
  });

  it("删除该日之前需确认并调 deleteLogsBefore", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("删除该日之前")).toBeInTheDocument());

    const dateInput = screen.getByLabelText("清理日期");
    fireEvent.change(dateInput, { target: { value: "2024-01-15" } });

    fireEvent.click(screen.getByText("删除该日之前"));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("不可恢复"));
      expect(mockedApi.deleteLogsBefore).toHaveBeenCalled();
    });

    const beforeArg = mockedApi.deleteLogsBefore.mock.calls[0][0];
    expect(beforeArg).toBeGreaterThan(1705276800);
    expect(beforeArg).toBeLessThanOrEqual(1705363199);

    confirmSpy.mockRestore();
  });

  it("保留天数输入非负校验", async () => {
    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("日志保留天数")).toBeInTheDocument());

    const retentionInput = screen.getByLabelText("日志保留天数");
    fireEvent.change(retentionInput, { target: { value: "-1" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      expect(screen.getByText(/必须为非负整数/)).toBeInTheDocument();
    });
    expect(mockedApi.setLogRetentionDays).not.toHaveBeenCalled();

    fireEvent.change(retentionInput, { target: { value: "7" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => {
      expect(mockedApi.setLogRetentionDays).toHaveBeenCalledWith(7);
    });
  });

  it("日志表格时间列显示完整日期时间（含日期）", async () => {
    const ts = 1700000000;
    mockedApi.listLogs.mockResolvedValue({
      total: 1,
      items: [makeLog({ id: "l1", trace_id: "trace-abc", created_at: ts })],
    });

    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText(new Date(ts * 1000).toLocaleString())).toBeInTheDocument()
    );
  });

  it("按会话分组视图：按 trace_id 分组并展示会话汇总", async () => {
    mockedApi.listLogs.mockResolvedValue({
      total: 3,
      items: [
        makeLog({ id: "l1", trace_id: "trace-abc", created_at: 1700000000 }),
        makeLog({ id: "l2", trace_id: "trace-abc", created_at: 1700000005 }),
        makeLog({ id: "l3", trace_id: "trace-def", created_at: 1700000010 }),
      ],
    });

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("按会话分组")).toBeInTheDocument());

    fireEvent.click(screen.getByText("按会话分组"));

    // 两个 trace 的会话汇总行可见
    await waitFor(() => expect(screen.getByText("trace-abc")).toBeInTheDocument());
    expect(screen.getByText("trace-def")).toBeInTheDocument();

    const abcRow = screen.getByText("trace-abc").closest("tr")!;
    expect(within(abcRow).getByText("2")).toBeInTheDocument();
    expect(within(abcRow).getByText("sonnet")).toBeInTheDocument();
    expect(within(abcRow).getByText("200")).toBeInTheDocument();
  });

  it("展开会话后显示该 trace 的全部日志", async () => {
    mockedApi.listLogs.mockResolvedValue({
      total: 2,
      items: [
        makeLog({ id: "l1", trace_id: "trace-abc", created_at: 1700000000 }),
        makeLog({ id: "l2", trace_id: "trace-abc", created_at: 1700000005 }),
      ],
    });

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("按会话分组")).toBeInTheDocument());
    fireEvent.click(screen.getByText("按会话分组"));

    fireEvent.click(await screen.findByText("trace-abc"));

    // 会话内的两条日志都渲染出请求模型单元格
    await waitFor(() => expect(screen.getAllByText("model-a")).toHaveLength(2));
  });

  it("会话内日志可展开详情（含 TraceID）", async () => {
    mockedApi.listLogs.mockResolvedValue({
      total: 1,
      items: [makeLog({ id: "l1", trace_id: "trace-abc", created_at: 1700000000 })],
    });

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("按会话分组")).toBeInTheDocument());
    fireEvent.click(screen.getByText("按会话分组"));
    fireEvent.click(await screen.findByText("trace-abc"));

    // 点击会话内日志行展开详情
    await waitFor(() => expect(screen.getAllByText("model-a").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("model-a")[0].closest("tr")!);

    await waitFor(() => expect(screen.getByText(/TraceID: trace-abc/)).toBeInTheDocument());
  });

  it("切换回平铺列表视图", async () => {
    mockedApi.listLogs.mockResolvedValue({
      total: 1,
      items: [makeLog({ id: "l1", trace_id: "trace-abc", created_at: 1700000000 })],
    });

    render(<LogsPage />);
    await waitFor(() => expect(screen.getByText("按会话分组")).toBeInTheDocument());
    fireEvent.click(screen.getByText("按会话分组"));
    await waitFor(() => expect(screen.getByText("trace-abc")).toBeInTheDocument());

    fireEvent.click(screen.getByText("平铺列表"));
    // 平铺视图下 trace 短名不再作为会话行展示
    expect(screen.queryByText("trace-abc")).not.toBeInTheDocument();
  });

  it("选择预设后 stats/trend 立即用新范围请求(不残留旧 filter)", async () => {
    render(<LogsPage />);
    await waitFor(() => expect(mockedApi.getLogTimeseries).toHaveBeenCalled());
    const firstAfter = mockedApi.getLogTimeseries.mock.calls[0][0].after;

    fireEvent.click(screen.getByRole("button", { name: /7d/ }));
    fireEvent.click(await screen.findByRole("button", { name: "1d" }));

    await waitFor(() => {
      expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(2);
    });
    const [f2, bs2] = mockedApi.getLogTimeseries.mock.calls[1];
    expect(f2.before! - f2.after!).toBeGreaterThan(86000);
    expect(f2.before! - f2.after!).toBeLessThan(87000);
    expect(f2.after).not.toBe(firstAfter);
    expect(bs2).toBe(3600);
    expect(mockedApi.getLogStats).toHaveBeenCalledTimes(2);
    expect(mockedApi.getLogStats.mock.calls[1][0].after).toBe(f2.after);
  });
});
