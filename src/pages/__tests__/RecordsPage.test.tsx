import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";
import RecordsPage from "../RecordsPage";
import { api } from "../../lib/api";

// 回归：会话页「查看日志」跳转到 /logs?tab=logs&session_id=… 后，
// RecordsPage 必须随 URL 查询切换页签（旧实现用本地 useState，同路由不同查询不重挂载导致点击无效）。
vi.mock("../../components/LogTrendChart", () => ({
  default: function LogTrendChartMock() {
    return <div data-testid="trend-chart">chart</div>;
  },
}));

vi.mock("../../lib/api", () => ({
  api: {
    // LogsPage
    listChannels: vi.fn().mockResolvedValue([]),
    listApiKeys: vi.fn().mockResolvedValue([]),
    listLogs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getLogStats: vi.fn().mockResolvedValue({
      total_calls: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost: 0,
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
    // SessionsPage
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    deleteSession: vi.fn().mockResolvedValue(true),
  },
}));

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <RecordsPage />
    </MemoryRouter>
  );
}

describe("RecordsPage 页签由 URL 查询驱动", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("默认 ?tab 缺省时落在日志页签", async () => {
    renderAt("/logs");
    await waitFor(() => expect(screen.getByText("暂无日志")).toBeInTheDocument());
  });

  it("?tab=sessions 时展示会话页而非日志页", async () => {
    renderAt("/logs?tab=sessions");
    await waitFor(() => expect(screen.getByText("暂无会话")).toBeInTheDocument());
    expect(screen.queryByText("暂无日志")).not.toBeInTheDocument();
  });

  it("从会话页签点击「日志」切回日志页（URL 查询更新）", async () => {
    renderAt("/logs?tab=sessions");
    await waitFor(() => expect(screen.getByText("暂无会话")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "日志" }));

    await waitFor(() => expect(screen.getByText("暂无日志")).toBeInTheDocument());
    expect(screen.queryByText("暂无会话")).not.toBeInTheDocument();
  });

  it("携带 session 查询进入时落在日志页签并应用会话筛选", async () => {
    renderAt("/logs?tab=logs&session_id=sess-abc&session_provider=claude");
    await waitFor(() => expect(screen.getByText("暂无日志")).toBeInTheDocument());
    const calls = vi.mocked(api.listLogs).mock.calls;
    const lastFilter = calls[calls.length - 1][0] as { session_id?: string };
    expect(lastFilter.session_id).toBe("sess-abc");
  });
});
