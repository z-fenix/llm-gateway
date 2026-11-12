import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ChannelForm from "../ChannelForm";
import { api } from "../../lib/api";
vi.mock("../../lib/api", () => ({ api: { listChannelModels: vi.fn(), getModelMap: vi.fn().mockResolvedValue([]) } }));
const show = () => render(<ChannelForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
beforeEach(() => vi.clearAllMocks());
describe("新建渠道真实模型结果", () => {
  it("空上游明确提示而不把静态模型标为上游成功", async () => {
    vi.mocked(api.listChannelModels).mockResolvedValue([]);
    show(); fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByText(/上游返回空模型列表/)).toBeInTheDocument();
    expect(screen.queryByText(/已从上游加载模型/)).not.toBeInTheDocument();
  });
  it("错误可见且保留手动填写能力", async () => {
    vi.mocked(api.listChannelModels).mockRejectedValue("上游返回状态码 401");
    show(); fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("401");
    expect(screen.getByPlaceholderText("输入或选择模型…")).toBeEnabled();
  });
  it("只列出真实上游结果，不混入不受支持的静态模型", async () => {
    vi.mocked(api.listChannelModels).mockResolvedValue(["private-model", "private-model"]);
    show(); fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    expect(await screen.findByRole("option", { name: "private-model" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "gpt-4o" })).not.toBeInTheDocument();
  });
  it("修改地址使旧请求失效，不能显示上一地址的模型", async () => {
    let resolve!: (v: string[]) => void;
    vi.mocked(api.listChannelModels).mockImplementation(() => new Promise(r => { resolve = r; }));
    show(); fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "http://localhost:9999" } });
    await act(async () => resolve(["old-server-model"]));
    expect(screen.queryByRole("option", { name: "old-server-model" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "获取模型列表" })).toBeEnabled();
  });
});
