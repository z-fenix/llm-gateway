import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import RoleRoutesPage from "../RoleRoutesPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    listRoleRoutes: vi.fn().mockResolvedValue([
      { id: "r1", role: "sonnet", channel_id: "c1", target_model: "deepseek-v4-flash", enabled: true, updated_at: 1 },
    ]),
    listRolePatterns: vi.fn().mockResolvedValue([
      { id: "p1", pattern: "*sonnet*", role: "sonnet", priority: 100, enabled: true },
    ]),
    listChannels: vi.fn().mockResolvedValue([
      { id: "c1", name: "DeepSeek", provider_type: "deepseek", base_url: "http://x", api_key: "k", models: [], priority: 0, weight: 1, enabled: true, timeout_secs: 60, total_calls: 0, total_tokens: 0, success_rate: 1, avg_latency_ms: 0, created_at: 1, updated_at: 1 },
    ]),
    getFallback: vi.fn().mockResolvedValue(["c2", "kimi-k3"]),
    setRoleRoute: vi.fn().mockResolvedValue(undefined),
    deleteRoleRoute: vi.fn().mockResolvedValue(undefined),
    setFallback: vi.fn().mockResolvedValue(undefined),
    clearFallback: vi.fn().mockResolvedValue(undefined),
    deleteRolePattern: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("RoleRoutesPage", () => {
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
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.change(select, { target: { value: "c1" } });
    await waitFor(() => expect(api.setRoleRoute).toHaveBeenCalledWith("sonnet", "c1", expect.any(String)));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(api.deleteRoleRoute).toHaveBeenCalledWith("sonnet"));
  });
});
