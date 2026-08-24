import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  overrides: Partial<SessionMeta> = {}
): SessionMeta => ({
  providerId: "claude",
  sessionId: "sess-abc",
  title: "测试会话",
  projectDir: "/repo/app",
  createdAt: 1700000000000,
  lastActiveAt: 1700000010000,
  sourcePath: "/home/u/.claude/projects/app/sess-abc.jsonl",
  ...overrides,
});

const makeMessage = (role: string, content: string): SessionMessage => ({
  role,
  content,
  ts: 1700000000000,
});

describe("SessionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listSessions.mockResolvedValue([]);
    mockedApi.getSessionMessages.mockResolvedValue([]);
    mockedApi.deleteSession.mockResolvedValue(true);
  });

  it("空列表展示空状态", async () => {
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(mockedApi.listSessions).toHaveBeenCalled());
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
  });

  it("列表渲染会话标题、provider 徽标与项目目录", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession({ title: "会话甲" }),
      makeSession({ providerId: "codex", sessionId: "sess-def", title: "会话乙", projectDir: "/repo/b" }),
    ]);

    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("会话甲")).toBeInTheDocument());
    expect(screen.getByText("会话乙")).toBeInTheDocument();
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getByText("/repo/app")).toBeInTheDocument();
  });

  it("provider 筛选只显示对应会话", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession({ title: "Claude 会话" }),
      makeSession({ providerId: "gemini", title: "Gemini 会话" }),
    ]);

    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Claude 会话")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Gemini" }));

    await waitFor(() => {
      expect(screen.queryByText("Claude 会话")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Gemini 会话")).toBeInTheDocument();
  });

  it("搜索输入按标题过滤", async () => {
    mockedApi.listSessions.mockResolvedValue([
      makeSession({ title: "登录问题排查" }),
      makeSession({ title: "另一个会话" }),
    ]);

    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("登录问题排查")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("搜索标题 / 项目目录 / 会话 ID");
    fireEvent.change(input, { target: { value: "登录" } });

    await waitFor(() => {
      expect(screen.getByText("登录问题排查")).toBeInTheDocument();
      expect(screen.queryByText("另一个会话")).not.toBeInTheDocument();
    });
  });

  it("点击会话请求消息并渲染", async () => {
    mockedApi.listSessions.mockResolvedValue([makeSession()]);
    mockedApi.getSessionMessages.mockResolvedValue([
      makeMessage("user", "你好"),
      makeMessage("assistant", "你好，有什么可以帮忙？"),
    ]);

    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("测试会话")).toBeInTheDocument());

    fireEvent.click(screen.getByText("测试会话"));
    await waitFor(() =>
      expect(mockedApi.getSessionMessages).toHaveBeenCalledWith(
        "claude",
        "/home/u/.claude/projects/app/sess-abc.jsonl",
      )
    );

    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.getByText("你好，有什么可以帮忙？")).toBeInTheDocument();
    expect(screen.getByText("用户")).toBeInTheDocument();
    expect(screen.getByText("助手")).toBeInTheDocument();
  });

  it("删除走确认对话框并调用 deleteSession", async () => {
    mockedApi.listSessions.mockResolvedValue([makeSession({ title: "待删除" })]);

    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("待删除")).toBeInTheDocument());

    // 触发会话行的删除按钮
    fireEvent.click(screen.getByRole("button", { name: "删除会话" }));

    expect(
      await screen.findByRole("heading", { name: "删除会话" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(mockedApi.deleteSession).toHaveBeenCalledWith(
        "claude",
        "sess-abc",
        "/home/u/.claude/projects/app/sess-abc.jsonl",
      )
    );
  });
});
