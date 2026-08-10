import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
    const { container } = render(<LogsPage />);
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeInTheDocument());
    // 默认无时间范围，按天
    expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400");

    const dateInputs = container.querySelectorAll('input[type="date"]:not(#cleanup-date)');
    expect(dateInputs.length).toBe(2);
    const [afterInput, beforeInput] = Array.from(dateInputs);

    fireEvent.change(afterInput, { target: { value: "2024-01-01" } });
    fireEvent.change(beforeInput, { target: { value: "2024-01-01" } });
    fireEvent.click(screen.getByText("查询"));

    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "3600")
    );

    fireEvent.change(afterInput, { target: { value: "2024-01-01" } });
    fireEvent.change(beforeInput, { target: { value: "2024-01-03" } });
    fireEvent.click(screen.getByText("查询"));

    await waitFor(() =>
      expect(screen.getByTestId("trend-chart")).toHaveAttribute("data-bucket-secs", "86400")
    );
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
});
