import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import ApiKeysPage from "../ApiKeysPage";
import LogsPage from "../LogsPage";
import RoleRoutesPage from "../RoleRoutesPage";
import SessionsPage from "../SessionsPage";
import "../../components/sessions/SessionReader";
import Layout from "../../components/Layout";

vi.mock("../../components/LogTrendChart", () => ({ default: () => <div>趋势图</div> }));
vi.mock("../../lib/api", () => ({ api: Object.fromEntries([
  "listChannels", "listApiKeys", "listLogs", "getLogStats", "getLogTimeseries", "getLogRetentionDays", "listRoleRoutes", "listRolePatterns", "getFallback", "getBreakerStatus", "getRoleStats", "listSessions", "getSessionMessages", "getAppConfig", "updateApiKey", "setApiKeyEnabled", "deleteApiKey",
].map(name => [name, vi.fn()])) }));
const mocked = vi.mocked(api);
const mount = (element: React.ReactNode) => render(<MemoryRouter>{element}</MemoryRouter>);
const key = { id: "k1", name: "开发工具", key: "lgw_demo_masked", enabled: true, quota_total: 20000000, quota_used: 8420000, total_calls: 22, total_tokens: 8420000, created_at: 1, last_used_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listChannels.mockResolvedValue([]);
  mocked.listApiKeys.mockResolvedValue([key]);
  mocked.listLogs.mockResolvedValue({ items: [], total: 0 });
  mocked.getLogStats.mockResolvedValue({ total_calls: 0, total_input_tokens: 0, total_output_tokens: 0, success_count: 0, risk_distribution: [], top_channels: [], top_api_keys: [] });
  mocked.getLogTimeseries.mockResolvedValue([]);
  mocked.getLogRetentionDays.mockResolvedValue(30);
  mocked.listRoleRoutes.mockResolvedValue([{ id: "r1", role: "sonnet", channel_id: "c1", target_model: "saved", priority: 1, weight: 1, enabled: true, breaker_max_failures: 5, breaker_cooldown_secs: 60, updated_at: 1 }]);
  mocked.listRolePatterns.mockResolvedValue([]);
  mocked.getFallback.mockResolvedValue(null);
  mocked.getBreakerStatus.mockResolvedValue([{ route_id: "r1", state: "half_open", failures: 2 }]);
  mocked.getRoleStats.mockResolvedValue([]);
  mocked.getAppConfig.mockResolvedValue({ preferred_port: 8777, bound_addr: "127.0.0.1:8777", minimize_to_tray: true });
  mocked.listSessions.mockResolvedValue([{ providerId: "claude", sessionId: "s1", title: "排查角色路由", projectDir: "/repo/gateway", sourcePath: "/demo.jsonl", createdAt: 1700000000000 }]);
  mocked.getSessionMessages.mockResolvedValue([{ role: "user", content: "检查配置", ts: 1700000000000 }, { role: "tool", content: "读取完成", ts: 1700000000001 }]);
  mocked.updateApiKey.mockResolvedValue(undefined);
});

describe("第二轮九项问题回归", () => {
  it("日志渠道筛选使用可展开的设计下拉，不是浏览器原生 select", async () => {
    mocked.listChannels.mockResolvedValue([{ id: "c1", name: "主渠道" } as never]);
    mount(<LogsPage />);
    const trigger = screen.getByRole("combobox", { name: "渠道筛选" });
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "主渠道" }));
    fireEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(mocked.listLogs).toHaveBeenLastCalledWith(expect.objectContaining({ channel_id: "c1", offset: 0 })));
  });

  it("角色显示中文说明与原标识，半开状态不能误报正常", async () => {
    mount(<RoleRoutesPage />);
    expect(await screen.findByText("均衡任务")).toBeInTheDocument();
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("半开")).toBeInTheDocument();
    expect(screen.queryByText("正常")).not.toBeInTheDocument();
  });

  it("缺失熔断数据时显示未知而非正常", async () => {
    mocked.getBreakerStatus.mockResolvedValue([]);
    mount(<RoleRoutesPage />);
    expect(await screen.findByText("状态未知")).toBeInTheDocument();
  });

  it("密钥表为五列，单位、剩余配额、开关与管理入口符合设计", async () => {
    mount(<ApiKeysPage />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map(n => n.textContent)).toEqual(["名称 / 最近使用", "API 密钥", "Token 用量 / 配额", "启用", "操作"]);
    expect(within(table).getByText("8.42M / 20M")).toBeInTheDocument();
    expect(within(table).getByText("剩余 11.58M")).toBeInTheDocument();
    expect(within(table).getByRole("switch", { name: "启用 开发工具" })).toBeChecked();
    fireEvent.click(within(table).getByRole("button", { name: "管理密钥" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("累计调用");
    expect(screen.getByRole("button", { name: "复制密钥" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除密钥" })).toBeInTheDocument();
  });

  it("配额输入 M 单位提交整数，未改动的缩写不会损失精度", async () => {
    mocked.listApiKeys.mockResolvedValue([{ ...key, quota_total: 1000001 }]);
    mount(<ApiKeysPage />);
    fireEvent.click(await screen.findByRole("button", { name: "管理密钥" }));
    const quota = screen.getByLabelText("Token 配额");
    expect(quota).toHaveValue("1.000001M");
    fireEvent.change(quota, { target: { value: "1.5M" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() => expect(mocked.updateApiKey).toHaveBeenCalledWith("k1", "开发工具", 1500000));
  });

  it("会话消息显示选中标题、项目路径和轻量 USER/TOOL 元信息", async () => {
    mount(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /排查角色路由/ }));
    fireEvent.click(await screen.findByRole("button", {name:/执行过程/}, {timeout:10000}));
    fireEvent.click(screen.getByRole("button", {name:/工具输出/}));
    expect(await screen.findByText("读取完成")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "排查角色路由" })).toBeInTheDocument();
    expect(screen.getByText("USER")).toBeInTheDocument();
    expect(screen.getByText("TOOL")).toBeInTheDocument();
    expect(screen.getByLabelText("会话项目路径")).toHaveTextContent("/repo/gateway");
  });

  it("应用栏可选择深色、浅色和跟随系统", async () => {
    mount(<Layout />);
    fireEvent.click(screen.getByRole("button", { name: "主题设置" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "深色" }));
    expect(document.documentElement).toHaveClass("dark");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "浅色" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(screen.getByRole("menuitemradio", { name: "跟随系统" })).toBeInTheDocument();
  });
});
