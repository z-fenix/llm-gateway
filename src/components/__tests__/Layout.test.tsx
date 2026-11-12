import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "../Layout";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { getAppConfig: vi.fn() } }));

function Workspace() {
  return (
    <MemoryRouter initialEntries={["/channels"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="channels" element={<h1>渠道内容</h1>} />
          <Route path="keys" element={<h1>密钥内容</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("Layout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getAppConfig).mockResolvedValue({
      preferred_port: 8080,
      bound_addr: "127.0.0.1:8080",
      minimize_to_tray: true,
    });
  });

  it("标识当前路由并显示真实服务地址", async () => {
    render(<Workspace />);
    expect(screen.getByRole("link", { name: "渠道" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("网关运行中")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:8080")).toBeInTheDocument();
  });

  it("服务读取失败时不宣称在线", async () => {
    vi.mocked(api.getAppConfig).mockRejectedValue(new Error("offline"));
    render(<Workspace />);
    expect(await screen.findByText("网关未连接")).toBeInTheDocument();
    expect(screen.queryByText("网关运行中")).not.toBeInTheDocument();
  });

  it("跳过导航聚焦主内容，不改变路由", async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("link", { name: "跳到主内容" }));
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.getByRole("heading", { name: "渠道内容" })).toBeInTheDocument();
    await screen.findByText("网关运行中");
  });

  it("打开移动导航，切换路由后自动关闭", async () => {
    render(<Workspace />);
    const opener = screen.getByRole("button", { name: "打开导航" });
    fireEvent.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("link", { name: "密钥" }));
    expect(await screen.findByRole("heading", { name: "密钥内容" })).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveAttribute("aria-expanded", "false"));
  });
  it("手动刷新后同步网关连接状态", async () => {
    render(<Workspace />);
    await screen.findByText("网关运行中");
    vi.mocked(api.getAppConfig).mockRejectedValueOnce(new Error("offline"));
    window.dispatchEvent(new Event("gateway-refresh"));
    expect(await screen.findByText("网关未连接")).toBeInTheDocument();
  });

});
