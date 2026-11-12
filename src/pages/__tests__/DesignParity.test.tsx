import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../DashboardPage";
import ResourcesPage from "../ResourcesPage";
import RecordsPage from "../RecordsPage";
import RoleRoutesPage from "../RoleRoutesPage";
import ApiKeysPage from "../ApiKeysPage";
import SettingsPage from "../SettingsPage";

vi.mock("../../components/LogTrendChart", () => ({ default: () => <div>趋势图</div> }));
vi.mock("../../lib/api", () => ({ api: {
  getStats: vi.fn().mockResolvedValue({ today_requests: 12, today_tokens: 100, total_requests: 50, total_tokens: 500, active_channels: 2, avg_latency_ms: 120 }),
  listChannels: vi.fn().mockResolvedValue([]), listApiKeys: vi.fn().mockResolvedValue([]),
  listRoleRoutes: vi.fn().mockResolvedValue([]), listRolePatterns: vi.fn().mockResolvedValue([]), getFallback: vi.fn().mockResolvedValue(null), getBreakerStatus: vi.fn().mockResolvedValue([]), getRoleStats: vi.fn().mockResolvedValue([]),
  listKbs: vi.fn().mockResolvedValue([]), getRagSettings: vi.fn().mockResolvedValue({ enabled: false }),
  listPrompts: vi.fn().mockResolvedValue([{ id: "p1", name: "团队模板", content: "# 原始内容", description: "开发约定", enabled: false }]),
  upsertPrompt: vi.fn().mockResolvedValue({ id: "p1" }),
  listMcpServers: vi.fn().mockResolvedValue([]), listSkills: vi.fn().mockResolvedValue([]), listInstalledSkills: vi.fn().mockResolvedValue([]),
  listSessions: vi.fn().mockResolvedValue([]), listLogs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getLogStats: vi.fn().mockResolvedValue({ total_calls: 0, total_input_tokens: 0, total_output_tokens: 0, success_count: 0, risk_distribution: [], top_channels: [], top_api_keys: [] }),
  getLogTimeseries: vi.fn().mockResolvedValue([]), getLogRetentionDays: vi.fn().mockResolvedValue(30),
  getAppConfig: vi.fn().mockResolvedValue({ preferred_port: 8777, bound_addr: "127.0.0.1:8777", minimize_to_tray: true }), getCliTargets: vi.fn().mockResolvedValue([]), getRectifierConfig: vi.fn().mockResolvedValue({ enabled: false }), listModelPrices: vi.fn().mockResolvedValue([]), defaultExportPath: vi.fn().mockResolvedValue("demo.json"),
} }));
import { api } from "../../lib/api";

const at = (element: React.ReactNode, url: string) => render(<MemoryRouter initialEntries={[url]}>{element}</MemoryRouter>);

describe("设计稿页面结构与入口回归", () => {
  beforeEach(() => vi.clearAllMocks());

  it("概览显示真实网关地址与接入入口", async () => {
    at(<DashboardPage />, "/");
    expect(await screen.findByRole("heading", { name: "运行概览" })).toBeVisible();
    expect(await screen.findByText("http://127.0.0.1:8777")).toBeVisible();
    expect(screen.getByRole("link", { name: /CLI 接入配置/ })).toHaveAttribute("href", "#/settings?section=cli");
  });

  it.each(["knowledge", "prompts", "mcp", "skills"])("资源 %s 保持共享标题在页签上方", async (tab) => {
    at(<ResourcesPage />, `/knowledge?tab=${tab}`);
    const heading = await screen.findByRole("heading", { level: 1, name: "资源" });
    expect(heading.compareDocumentPosition(screen.getByRole("tablist", { name: "资源类型" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("日志主视图保留更多筛选入口，清理功能按需打开", async () => {
    at(<RecordsPage />, "/logs");
    await screen.findByText("暂无日志");
    expect(screen.getByRole("heading", { level: 1, name: "日志与会话" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "日志清理" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /更多筛选/ }));
    expect(screen.getByLabelText("角色筛选")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "日志保留与清理" }));
    expect(screen.getByRole("heading", { name: "日志清理" })).toBeVisible();
  });

  it("角色规则通过入口展开，不占用概览首屏", async () => {
    render(<RoleRoutesPage />);
    await screen.findByText("6 个角色 · 0 个已配置");
    expect(screen.queryByRole("heading", { name: "角色识别规则" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理识别规则" }));
    expect(screen.getByRole("heading", { name: "角色识别规则" })).toBeVisible();
    expect(screen.getByRole("button", { name: "新增规则" })).toBeVisible();
  });

  it("密钥页提供摘要与 CLI 接入入口且创建表单按需打开", async () => {
    at(<ApiKeysPage />, "/keys");
    await screen.findByText("暂无密钥");
    expect(screen.getByText("密钥总数")).toBeVisible();
    expect(screen.getByRole("link", { name: /前往 CLI 接入配置/ })).toHaveAttribute("href", "#/settings?section=cli");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Prompt 工作区可直接编辑保存，但不会自动启用", async () => {
    at(<ResourcesPage />, "/knowledge?tab=prompts");
    const editor = await screen.findByRole("textbox", { name: "模板内容" });
    fireEvent.change(editor, { target: { value: "# 修改后的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
    await waitFor(() => expect(api.upsertPrompt).toHaveBeenCalledWith("p1", "团队模板", "# 修改后的内容", "开发约定"));
  });

  it("常规设置包含备份配置入口且 CLI 页签可切换", async () => {
    at(<SettingsPage />, "/settings");
    expect(await screen.findByRole("heading", { name: "更多配置" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "CLI 接入" }));
    expect(screen.getByLabelText("CLI 配置编辑区")).toBeVisible();
  });
});
