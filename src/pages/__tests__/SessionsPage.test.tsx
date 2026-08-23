import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SessionsPage from "../SessionsPage";
import { api } from "../../lib/api";
import type { SessionMeta, SessionMessage } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    deleteSession: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const makeSession = (
  traceId: string,
  overrides: Partial<SessionMeta> = {}
): SessionMeta => ({
  trace_id: traceId,
  title: null,
  first_active: 1700000000,
  last_active: 1700000010,
  message_count: 2,
  roles: [
    ["user", 1],
    ["assistant", 1],
  ],
  ...overrides,
});

const makeMessage = (
  seq: number,
  overrides: Partial<SessionMessage> = {}
): SessionMessage => ({
  seq,
  role: seq % 2 === 1 ? "user" : "assistant",
  content: `message ${seq}`,
  status_code: 200,
  created_at: 1700000000 + seq,
  error: null,
  ...overrides,
});

describe("SessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listSessions.mockResolvedValue([]);
    mockedApi.getSessionMessages.mockResolvedValue([]);
    mockedApi.deleteSession.mockResolvedValue(2);
  });

  it("空列表展示空状态", async () => {
    render(<SessionsPage />);
    await waitFor(() => expect(mockedApi.listSessions).toHaveBeenCalled());
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
  });

  it("列表渲染会话标题、消息数与角色", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession("trace-abc", { title: "测试会话", message_count: 3 }),
      makeSession("trace-def", { title: null, message_count: 5 }),
    ]);

    render(<SessionsPage />);
    await waitFor(() => expect(screen.getByText("测试会话")).toBeInTheDocument());
    expect(screen.getByText("trace-def")).toBeInTheDocument();

    const abcButton = screen.getByText("测试会话").closest("button")!;
    expect(within(abcButton).getByText("3")).toBeInTheDocument();
    expect(within(abcButton).getByText("user: 1")).toBeInTheDocument();
    expect(within(abcButton).getByText("assistant: 1")).toBeInTheDocument();
  });

  it("搜索输入按标题或 trace_id 过滤", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession("trace-abc", { title: "测试会话" }),
      makeSession("trace-def", { title: "另一个会话" }),
    ]);

    render(<SessionsPage />);
    await waitFor(() =>
      expect(screen.getByText("测试会话")).toBeInTheDocument()
    );
    expect(screen.getByText("另一个会话")).toBeInTheDocument();

    const input = screen.getByPlaceholderText("搜索 trace_id / 标题");
    fireEvent.change(input, { target: { value: "trace-def" } });

    await waitFor(() => {
      expect(screen.queryByText("测试会话")).not.toBeInTheDocument();
    });
    expect(screen.getByText("另一个会话")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "测试" } });
    await waitFor(() => {
      expect(screen.getByText("测试会话")).toBeInTheDocument();
      expect(screen.queryByText("另一个会话")).not.toBeInTheDocument();
    });
  });

  it("点击会话请求消息并渲染", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession("trace-abc", { title: "测试会话" }),
    ]);
    mockedApi.getSessionMessages.mockResolvedValue([
      makeMessage(1, { role: "user", content: "你好" }),
      makeMessage(2, { role: "assistant", content: "你好，有什么可以帮忙？" }),
    ]);

    render(<SessionsPage />);
    await waitFor(() => expect(screen.getByText("测试会话")).toBeInTheDocument());

    fireEvent.click(screen.getByText("测试会话"));
    await waitFor(() =>
      expect(mockedApi.getSessionMessages).toHaveBeenCalledWith("trace-abc")
    );

    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.getByText("你好，有什么可以帮忙？")).toBeInTheDocument();
  });

  it("消息错误显示红色错误指示", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession("trace-err", { title: "错误会话" }),
    ]);
    mockedApi.getSessionMessages.mockResolvedValue([
      makeMessage(1, { error: "upstream timeout" }),
    ]);

    render(<SessionsPage />);
    await waitFor(() => expect(screen.getByText("错误会话")).toBeInTheDocument());
    fireEvent.click(screen.getByText("错误会话"));

    await waitFor(() =>
      expect(screen.getByText(/upstream timeout/)).toBeInTheDocument()
    );
  });

  it("删除走确认对话框并调用 deleteSession", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession("trace-del", { title: "待删除" }),
    ]);

    render(<SessionsPage />);
    await waitFor(() => expect(screen.getByText("待删除")).toBeInTheDocument());

    fireEvent.click(screen.getByText("待删除"));
    await waitFor(() => expect(mockedApi.getSessionMessages).toHaveBeenCalledWith("trace-del")
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除会话" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(mockedApi.deleteSession).toHaveBeenCalledWith("trace-del")
    );
  });
});
