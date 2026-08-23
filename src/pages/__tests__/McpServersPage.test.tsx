import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import McpServersPage from "../McpServersPage";
import { api } from "../../lib/api";
import type { McpServer, McpServerView } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listMcpServers: vi.fn(),
    upsertMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    toggleMcpServerEnabled: vi.fn(),
    connectMcpServer: vi.fn(),
    disconnectMcpServer: vi.fn(),
    testMcpConnection: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const server = (id: string, overrides: Partial<McpServer> = {}): McpServer => ({
  id,
  name: `mcp-${id}`,
  server_config: { type: "stdio", command: `cmd-${id}` },
  description: `desc-${id}`,
  enabled: false,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

const view = (id: string, overrides: Partial<McpServerView> = {}): McpServerView => ({
  server: server(id),
  connected: false,
  ...overrides,
});

describe("McpServersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listMcpServers.mockResolvedValue([]);
    mockedApi.upsertMcpServer.mockResolvedValue(server("s1"));
    mockedApi.deleteMcpServer.mockResolvedValue(undefined);
    mockedApi.toggleMcpServerEnabled.mockResolvedValue(undefined);
    mockedApi.connectMcpServer.mockResolvedValue(undefined);
    mockedApi.disconnectMcpServer.mockResolvedValue(undefined);
    mockedApi.testMcpConnection.mockResolvedValue("连接成功");
  });

  it("空列表展示空状态与新增引导", async () => {
    render(<McpServersPage />);
    await waitFor(() => expect(api.listMcpServers).toHaveBeenCalled());
    expect(screen.getByText("暂无 MCP 服务器")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新增 MCP 服务器" })
    ).toBeInTheDocument();
  });

  it("列表渲染服务器、类型徽标与连接状态徽标", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", {
        connected: true,
        server: server("s1", {
          name: "本地 Python",
          server_config: { type: "stdio", command: "python server.py" },
        }),
      }),
      view("s2", {
        connected: false,
        server: server("s2", {
          name: "远程 HTTP",
          server_config: { type: "http", url: "https://example.com/mcp" },
        }),
      }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("本地 Python")).toBeInTheDocument());
    expect(screen.getByText("远程 HTTP")).toBeInTheDocument();
    expect(screen.getByText("stdio")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.getByText("未连接")).toBeInTheDocument();
  });

  it("点击启用开关调用 toggleMcpServerEnabled 并刷新列表", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", { server: server("s1", { name: "本地服务", enabled: false }) }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("本地服务")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(api.toggleMcpServerEnabled).toHaveBeenCalledWith("s1", true)
    );
    await waitFor(() => expect(api.listMcpServers).toHaveBeenCalledTimes(2));
  });

  it("新增 stdio 服务器，填写 command/args/env 后保存调用 upsertMcpServer", async () => {
    render(<McpServersPage />);
    await waitFor(() => expect(api.listMcpServers).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    expect(
      await screen.findByRole("heading", { name: "新增 MCP 服务器" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Python 服务" },
    });
    fireEvent.change(screen.getByLabelText("命令"), {
      target: { value: "python" },
    });

    fireEvent.click(screen.getByRole("button", { name: "添加参数" }));
    fireEvent.change(screen.getByPlaceholderText("参数"), {
      target: { value: "server.py" },
    });

    fireEvent.click(screen.getByRole("button", { name: "添加环境变量" }));
    fireEvent.change(screen.getByPlaceholderText("KEY"), {
      target: { value: "PORT" },
    });
    fireEvent.change(screen.getByPlaceholderText("VALUE"), {
      target: { value: "8080" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.upsertMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "",
          name: "Python 服务",
          enabled: false,
          created_at: 0,
          server_config: {
            type: "stdio",
            command: "python",
            args: ["server.py"],
            env: { PORT: "8080" },
          },
        })
      )
    );
  });

  it("切换为 http 类型显示 url/headers 并保存正确配置", async () => {
    render(<McpServersPage />);
    await waitFor(() => expect(api.listMcpServers).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await screen.findByRole("heading", { name: "新增 MCP 服务器" });

    fireEvent.click(screen.getByRole("combobox", { name: "类型" }));
    fireEvent.click(await screen.findByRole("option", { name: "http" }));

    // stdio 条件字段应被清空隐藏
    expect(screen.queryByLabelText("命令")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "远程服务" },
    });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/mcp" },
    });

    fireEvent.click(screen.getByRole("button", { name: "添加请求头" }));
    fireEvent.change(screen.getByPlaceholderText("KEY"), {
      target: { value: "Authorization" },
    });
    fireEvent.change(screen.getByPlaceholderText("VALUE"), {
      target: { value: "Bearer x" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.upsertMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "",
          name: "远程服务",
          created_at: 0,
          server_config: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer x" },
          },
        })
      )
    );
  });

  it("编辑对话框预填配置并保存保留原 id", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", {
        server: server("s1", {
          name: "旧服务",
          enabled: true,
          server_config: { type: "stdio", command: "old-cmd", args: ["a"] },
        }),
      }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("旧服务")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      await screen.findByRole("heading", { name: "编辑 MCP 服务器" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("旧服务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old-cmd")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "新服务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.upsertMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s1",
          name: "新服务",
          enabled: true,
          created_at: 1,
          server_config: expect.objectContaining({ command: "old-cmd" }),
        })
      )
    );
  });

  it("测试按钮调用 testMcpConnection 并展示成功提示", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", { server: server("s1", { name: "待测试" }) }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("待测试")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() =>
      expect(api.testMcpConnection).toHaveBeenCalledWith("s1")
    );
  });

  it("连接/断开按钮调用对应命令", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", {
        connected: true,
        server: server("s1", { name: "已连接服务" }),
      }),
      view("s2", { server: server("s2", { name: "未连接服务" }) }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("已连接服务")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    await waitFor(() =>
      expect(api.disconnectMcpServer).toHaveBeenCalledWith("s1")
    );

    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() =>
      expect(api.connectMcpServer).toHaveBeenCalledWith("s2")
    );
  });

  it("删除走确认对话框并调用 deleteMcpServer", async () => {
    mockedApi.listMcpServers.mockResolvedValue([
      view("s1", { server: server("s1", { name: "待删除" }) }),
    ]);
    render(<McpServersPage />);
    await waitFor(() => expect(screen.getByText("待删除")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除 MCP 服务器" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.deleteMcpServer).toHaveBeenCalledWith("s1"));
  });
});
