import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ChannelForm from "../ChannelForm";
import { api } from "../../lib/api";
import type { Channel } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    getModelMap: vi.fn(),
    setModelMap: vi.fn().mockResolvedValue(undefined),
    deleteModelMap: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

const editForm = (id = "c1"): Partial<Channel> => ({
  id,
  name: "测试渠道",
  supplier: "openai",
  upstream_protocol: "openai-chat",
  base_url: "https://api.openai.com",
  api_key: "sk-test",
  models: ["gpt-4o"],
  priority: 0,
  weight: 1,
  enabled: true,
  timeout_secs: 60,
});

describe("ChannelForm 模型映射", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedApi.getModelMap.mockResolvedValue([]);
  });

  it("新建模式（无 id）不请求模型映射", () => {
    render(<ChannelForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(mockedApi.getModelMap).not.toHaveBeenCalled();
    expect(screen.queryByText("模型映射")).not.toBeInTheDocument();
  });

  it("编辑模式加载并列出模型映射", async () => {
    mockedApi.getModelMap.mockResolvedValue([
      { channel_id: "c1", source_model: "sonnet", target_model: "claude-sonnet-4-5" },
    ]);
    render(<ChannelForm initial={editForm()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(mockedApi.getModelMap).toHaveBeenCalledWith("c1"));
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument();
  });

  it("空映射展示空提示", async () => {
    render(<ChannelForm initial={editForm()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("暂无模型映射")).toBeInTheDocument());
  });

  it("模型映射加载失败展示错误提示而非“暂无模型映射”", async () => {
    mockedApi.getModelMap.mockRejectedValue(new Error("load failed"));
    render(<ChannelForm initial={editForm()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(mockedApi.getModelMap).toHaveBeenCalledWith("c1"));
    expect(screen.getByText("模型映射加载失败")).toBeInTheDocument();
    expect(screen.queryByText("暂无模型映射")).not.toBeInTheDocument();
  });

  it("添加映射调用 setModelMap 并重新加载", async () => {
    render(<ChannelForm initial={editForm()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("暂无模型映射")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("源模型"), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByPlaceholderText("目标模型"), { target: { value: "claude-sonnet-4-5" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(mockedApi.setModelMap).toHaveBeenCalledWith("c1", "sonnet", "claude-sonnet-4-5")
    );
    expect(mockedApi.getModelMap).toHaveBeenCalledTimes(2);
  });

  it("删除映射调用 deleteModelMap 并重新加载", async () => {
    mockedApi.getModelMap.mockResolvedValue([
      { channel_id: "c1", source_model: "opus", target_model: "claude-opus-4" },
    ]);
    render(<ChannelForm initial={editForm()} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("opus")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(mockedApi.deleteModelMap).toHaveBeenCalledWith("c1", "opus"));
    expect(mockedApi.getModelMap).toHaveBeenCalledTimes(2);
  });
});
