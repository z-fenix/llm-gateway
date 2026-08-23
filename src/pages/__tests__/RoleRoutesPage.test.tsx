import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import RoleRoutesPage from "../RoleRoutesPage";
import { api } from "../../lib/api";
import type { Channel, RolePattern } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listRoleRoutes: vi.fn(),
    listRolePatterns: vi.fn(),
    listChannels: vi.fn(),
    getFallback: vi.fn(),
    setRoleRoute: vi.fn().mockResolvedValue(undefined),
    deleteRoleRoute: vi.fn().mockResolvedValue(undefined),
    setFallback: vi.fn().mockResolvedValue(undefined),
    clearFallback: vi.fn().mockResolvedValue(undefined),
    upsertRolePattern: vi.fn().mockResolvedValue(undefined),
    deleteRolePattern: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

const channel = (id: string, name: string): Channel => ({
  id,
  name,
  supplier: "deepseek",
  upstream_protocol: "openai-chat",
  base_url: "http://x",
  api_key: "k",
  models: [],
  priority: 0,
  weight: 1,
  enabled: true,
  timeout_secs: 60,
  total_calls: 0,
  total_tokens: 0,
  success_rate: 1,
  avg_latency_ms: 0,
  created_at: 1,
  updated_at: 1,
});

const pattern = (id: string, overrides: Partial<RolePattern> = {}): RolePattern => ({
  id,
  pattern: "*sonnet*",
  role: "sonnet",
  priority: 100,
  enabled: true,
  ...overrides,
});

describe("RoleRoutesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listRoleRoutes.mockResolvedValue([
      { id: "r1", role: "sonnet", channel_id: "c1", target_model: "deepseek-v4-flash", enabled: true, updated_at: 1 },
    ]);
    mockedApi.listRolePatterns.mockResolvedValue([pattern("p1")]);
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", "DeepSeek"),
      channel("c2", "Kimi"),
    ]);
    mockedApi.getFallback.mockResolvedValue(["c2", "kimi-k3"]);
  });

  it("渲染四个角色并显示已绑定的上游模型", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("fable")).toBeInTheDocument();
    expect(screen.getByText("haiku")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument()
    );
  });

  it("切换角色渠道调用 setRoleRoute/deleteRoleRoute", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    // sonnet 当前已绑定 c1，先切换到 Kimi(c2)
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Kimi" }));
    await waitFor(() =>
      expect(api.setRoleRoute).toHaveBeenCalledWith(
        "sonnet",
        "c2",
        expect.any(String)
      )
    );

    // 再切回“不路由”触发 deleteRoleRoute
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(
      await screen.findByRole("option", { name: "（不路由 / 走普通调度）" })
    );
    await waitFor(() =>
      expect(api.deleteRoleRoute).toHaveBeenCalledWith("sonnet")
    );
  });

  it("渲染 Auto 行并可绑定渠道", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    // auto 行渲染，并带「未匹配角色」提示
    expect(screen.getByText("auto")).toBeInTheDocument();
    expect(screen.getByText("（未匹配角色）")).toBeInTheDocument();

    // 在 auto 行选择渠道 DeepSeek(c1)，触发 setRoleRoute("auto", ...)
    const autoSelect = screen.getByRole("combobox", { name: "auto 渠道" });
    fireEvent.click(autoSelect);
    fireEvent.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await waitFor(() =>
      expect(api.setRoleRoute).toHaveBeenCalledWith(
        "auto",
        "c1",
        expect.any(String)
      )
    );
  });

  it("切换全局兜底渠道调用 setFallback，清除按钮调用 clearFallback", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    // 兜底当前为 Kimi(c2)，切到 DeepSeek(c1)，保留模型
    const fallbackSelect = screen.getByRole("combobox", { name: "兜底渠道" });
    fireEvent.click(fallbackSelect);
    fireEvent.click(await screen.findByRole("option", { name: "DeepSeek" }));
    await waitFor(() =>
      expect(api.setFallback).toHaveBeenCalledWith("c1", "kimi-k3")
    );

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() => expect(api.clearFallback).toHaveBeenCalled());
  });

  it("新增规则：对话框填写并调用 upsertRolePattern", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "新增规则" })[0]);
    expect(
      await screen.findByRole("heading", { name: "新增规则" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("*sonnet*"), {
      target: { value: "*opus*" },
    });
    fireEvent.change(screen.getByLabelText("优先级"), {
      target: { value: "5" },
    });

    // 角色选择 auto（普通调度）
    fireEvent.click(screen.getByRole("combobox", { name: "规则角色" }));
    fireEvent.click(await screen.findByRole("option", { name: /auto/ }));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockedApi.upsertRolePattern).toHaveBeenCalled());
    expect(mockedApi.upsertRolePattern.mock.calls[0][0]).toMatchObject({
      id: "",
      pattern: "*opus*",
      role: "auto",
      priority: 5,
      enabled: true,
    });
  });

  it("编辑规则：对话框预填并保存原 id", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    expect(
      await screen.findByRole("heading", { name: "编辑规则" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("*sonnet*")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("*sonnet*"), {
      target: { value: "*sonnet2*" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockedApi.upsertRolePattern).toHaveBeenCalled());
    expect(mockedApi.upsertRolePattern.mock.calls[0][0]).toMatchObject({
      id: "p1",
      pattern: "*sonnet2*",
      role: "sonnet",
      priority: 100,
      enabled: true,
    });
  });

  it("删除规则走确认对话框并调用 deleteRolePattern", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByText("sonnet")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除规则" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.deleteRolePattern).toHaveBeenCalledWith("p1")
    );
  });
});
