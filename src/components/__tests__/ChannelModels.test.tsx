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
  it("请求开始时没有模型行，期间手动添加的模型不能被结果覆盖", async () => {
    let resolve!: (v: string[]) => void;
    vi.mocked(api.listChannelModels).mockImplementation(()=>new Promise(r=>{resolve=r;}));
    show();
    fireEvent.click(screen.getByRole("button",{name:"删除模型"}));
    fireEvent.click(screen.getByRole("button",{name:"获取模型列表"}));
    fireEvent.click(screen.getByRole("button",{name:/添加模型/}));
    fireEvent.change(screen.getByPlaceholderText("输入或选择模型…"),{target:{value:"manually-added"}});
    await act(async()=>resolve(["upstream-model"]));
    expect(screen.getByPlaceholderText("输入或选择模型…")).toHaveValue("manually-added");
    expect(screen.getByRole("option",{name:"upstream-model"})).toBeInTheDocument();
  });
  it("请求开始后删除全部模型，返回时应补行并展开候选", async () => {
    let resolve!: (v:string[])=>void;
    vi.mocked(api.listChannelModels).mockImplementation(()=>new Promise(r=>{resolve=r;}));
    show();
    fireEvent.click(screen.getByRole("button",{name:"获取模型列表"}));
    fireEvent.click(screen.getByRole("button",{name:"删除模型"}));
    await act(async()=>resolve(["upstream-model"]));
    expect(screen.getByRole("option",{name:"upstream-model"})).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入或选择模型…")).toHaveFocus();
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
