import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import RoleRoutesPage from "../RoleRoutesPage";
import { api } from "../../lib/api";
import type { Channel, RolePattern, RoleRoute } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listRoleRoutes: vi.fn(),
    listRolePatterns: vi.fn(),
    listChannels: vi.fn(),
    getFallback: vi.fn(),
    getBreakerStatus: vi.fn(),
    upsertRoleRoute: vi.fn().mockResolvedValue(undefined),
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

const route = (overrides: Partial<RoleRoute> = {}): RoleRoute => ({
  id: "r1",
  role: "sonnet",
  channel_id: "c1",
  target_model: "deepseek-v4-flash",
  priority: 0,
  weight: 1,
  breaker_max_failures: 5,
  breaker_cooldown_secs: 60,
  enabled: true,
  updated_at: 1,
  ...overrides,
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
    mockedApi.listRoleRoutes.mockResolvedValue([route()]);
    mockedApi.listRolePatterns.mockResolvedValue([pattern("p1")]);
    mockedApi.listChannels.mockResolvedValue([
      channel("c1", "DeepSeek"),
      channel("c2", "Kimi"),
    ]);
    mockedApi.getFallback.mockResolvedValue(["c2", "kimi-k3"]);
    mockedApi.getBreakerStatus.mockResolvedValue([
      { route_id: "r1", state: "closed", failures: 0 },
    ]);
  });

  it("空列表展示空状态与新增入口", async () => {
    mockedApi.listRoleRoutes.mockResolvedValue([]);
    render(<RoleRoutesPage />);
    await waitFor(() => expect(mockedApi.listRoleRoutes).toHaveBeenCalled());
    expect(screen.getByText("暂无角色路由")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新增路由" }).length).toBeGreaterThan(0);
  });

  it("渲染路由行、上游模型与熔断状态", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument()
    );
    expect(screen.getAllByText("sonnet").length).toBeGreaterThan(0);
    expect(screen.getByText("正常")).toBeInTheDocument();
  });

  it("切换路由渠道调用 upsertRoleRoute 保留其他字段", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

    const select = screen.getByRole("combobox", { name: "sonnet 渠道" });
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Kimi" }));

    await waitFor(() => expect(mockedApi.upsertRoleRoute).toHaveBeenCalled());
    const payload = mockedApi.upsertRoleRoute.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: "r1",
      role: "sonnet",
      channel_id: "c2",
      target_model: "deepseek-v4-flash",
    });
  });

  it("新增路由对话框创建多供应商路由", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增路由" }));
    expect(
      await screen.findByRole("heading", { name: "新增角色路由" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "路由角色" }));
    fireEvent.click(await screen.findByRole("option", { name: "opus" }));

    fireEvent.click(screen.getByRole("combobox", { name: "路由渠道" }));
    fireEvent.click(await screen.findByRole("option", { name: "DeepSeek" }));

    fireEvent.change(screen.getByPlaceholderText("如 deepseek-v4-flash"), {
      target: { value: "opus-model" },
    });
    fireEvent.change(screen.getByLabelText("优先级"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("权重"), {
      target: { value: "2" },
    });

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(mockedApi.upsertRoleRoute).toHaveBeenCalled());
    const payload = mockedApi.upsertRoleRoute.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: "",
      role: "opus",
      channel_id: "c1",
      target_model: "opus-model",
      priority: 10,
      weight: 2,
      breaker_max_failures: 5,
      breaker_cooldown_secs: 60,
      enabled: true,
    });
  });

  it("删除路由走确认对话框并调用 deleteRoleRoute(id)", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除路由" }));
    expect(
      await screen.findByRole("heading", { name: "删除路由" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(api.deleteRoleRoute).toHaveBeenCalledWith("r1")
    );
  });

  it("切换全局兜底渠道调用 setFallback，清除按钮调用 clearFallback", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "新增规则" }));
    expect(
      await screen.findByRole("heading", { name: "新增规则" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("*sonnet*"), {
      target: { value: "*opus*" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "规则角色" }));
    fireEvent.click(await screen.findByRole("option", { name: /auto/ }));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockedApi.upsertRolePattern).toHaveBeenCalled());
    expect(mockedApi.upsertRolePattern.mock.calls[0][0]).toMatchObject({
      id: "",
      pattern: "*opus*",
      role: "auto",
      priority: 0,
      enabled: true,
    });
  });

  it("编辑规则：对话框预填并保存原 id", async () => {
    render(<RoleRoutesPage />);
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
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
    await waitFor(() => expect(screen.getByDisplayValue("deepseek-v4-flash")).toBeInTheDocument());

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
