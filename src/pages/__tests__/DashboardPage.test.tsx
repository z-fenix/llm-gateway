import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import DashboardPage from "../DashboardPage";
import { api } from "../../lib/api";

vi.mock("../../components/LogTrendChart", () => ({
  default: function LogTrendChartMock(props: { dimension: string; bucketSecs: number }) {
    return <div data-testid="trend-chart" data-dimension={props.dimension} data-bucket-secs={props.bucketSecs}>chart</div>;
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    getStats: vi.fn(),
    getLogTimeseries: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const stats = {
  today_requests: 10,
  today_tokens: 1000,
  total_requests: 99,
  total_tokens: 5000,
  active_channels: 2,
  avg_latency_ms: 123,
};

const bucket = {
  bucket: 1704067200,
  calls: 5,
  input_tokens: 1,
  output_tokens: 1,
  error_count: 0,
  risk_counts: { clean: 5, info: 0, low: 0, medium: 0, high: 0, critical: 0 },
};

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedApi.getStats.mockResolvedValue(stats);
    mockedApi.getLogTimeseries.mockResolvedValue([bucket]);
  });

  it("统计数据未返回时展示加载状态", () => {
    mockedApi.getStats.mockReturnValue(new Promise(() => {}));
    render(<DashboardPage />);
    expect(screen.getByText("加载中...")).toBeInTheDocument();
  });

  it("渲染统计卡片与标题", async () => {
    render(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "概览" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("今日请求")).toBeInTheDocument());
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("1000")).toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.getByText("5000")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("123")).toBeInTheDocument();
    expect(screen.getByText("活跃渠道")).toBeInTheDocument();
  });

  it("挂载时请求 getStats 与 getLogTimeseries(当天 0 点 → now, 3600)", async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(mockedApi.getStats).toHaveBeenCalled());
    const [filter, bucketSecs] = mockedApi.getLogTimeseries.mock.calls[0];
    expect(bucketSecs).toBe(3600);
    const now = new Date();
    const expectedAfter = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
    );
    expect(filter.after).toBeDefined();
    expect(Math.abs((filter.after ?? 0) - expectedAfter)).toBeLessThan(5);
    expect(filter.before).toBeDefined();
    expect(Math.abs((filter.before ?? 0) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it("选择 30d 预设 → 按天 bucket 重新拉取趋势", async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /当天/ }));
    fireEvent.click(await screen.findByRole("button", { name: "30d" }));

    await waitFor(() => expect(mockedApi.getLogTimeseries).toHaveBeenCalledTimes(2));
    const [filter, bucketSecs] = mockedApi.getLogTimeseries.mock.calls[1];
    expect(bucketSecs).toBe(86400);
    const now = new Date();
    const expectedAfter = Math.floor(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime() / 1000
    );
    expect(Math.abs((filter.after ?? 0) - expectedAfter)).toBeLessThan(5);
  });

  it("趋势图以 hourly bucket 渲染并支持维度切换", async () => {
    render(<DashboardPage />);
    const chart = await screen.findByTestId("trend-chart");
    expect(chart).toHaveAttribute("data-bucket-secs", "3600");
    expect(chart).toHaveAttribute("data-dimension", "calls");

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

  it("无趋势数据时展示空状态", async () => {
    mockedApi.getLogTimeseries.mockResolvedValue([]);
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("暂无数据")).toBeInTheDocument());
    expect(screen.getByText("今天还没有请求记录")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-chart")).not.toBeInTheDocument();
  });
});
