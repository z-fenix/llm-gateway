import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import PromptsPage from "../PromptsPage";
import { api } from "../../lib/api";
import type { Prompt } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listPrompts: vi.fn(),
    upsertPrompt: vi.fn(),
    deletePrompt: vi.fn(),
    enablePrompt: vi.fn(),
    getEnabledPrompt: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const prompt = (id: string, overrides: Partial<Prompt> = {}): Prompt => ({
  id,
  name: `prompt-${id}`,
  content: `# prompt ${id}`,
  description: `desc-${id}`,
  enabled: false,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

describe("PromptsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listPrompts.mockResolvedValue([]);
    mockedApi.upsertPrompt.mockResolvedValue(prompt("p1"));
    mockedApi.deletePrompt.mockResolvedValue(undefined);
    mockedApi.enablePrompt.mockResolvedValue(undefined);
    mockedApi.getEnabledPrompt.mockResolvedValue(null);
  });

  it("空列表展示空状态与新增引导", async () => {
    render(<PromptsPage />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalled());
    expect(screen.getByText("暂无 Prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增 Prompt" })).toBeInTheDocument();
  });

  it("列表渲染 prompts 与启用开关", async () => {
    mockedApi.listPrompts.mockResolvedValue([
      prompt("p1", { name: "开发模板", enabled: true }),
      prompt("p2", { name: "写作模板", enabled: false }),
    ]);
    render(<PromptsPage />);
    await waitFor(() => expect(screen.getByText("开发模板")).toBeInTheDocument());
    expect(screen.getByText("写作模板")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBe(2);
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");
  });

  it("点击启用开关调用 enablePrompt 并刷新列表", async () => {
    mockedApi.listPrompts.mockResolvedValue([
      prompt("p1", { name: "开发模板", enabled: true }),
    ]);
    render(<PromptsPage />);
    await waitFor(() => expect(screen.getByText("开发模板")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(api.enablePrompt).toHaveBeenCalledWith("p1")
    );
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalledTimes(2));
  });

  it("打开新增对话框，填写后保存调用 upsertPrompt", async () => {
    render(<PromptsPage />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    expect(
      await screen.findByRole("heading", { name: "新增 Prompt" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "新模板" },
    });
    fireEvent.change(screen.getByLabelText("描述"), {
      target: { value: "测试描述" },
    });
    fireEvent.change(screen.getByLabelText(/^内容/), {
      target: { value: "# 测试内容" },
    });

    // DSH 改造后页脚按钮为「应用」（FormFooter 默认），旧断言「保存」属于本次修正
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() =>
      expect(api.upsertPrompt).toHaveBeenCalledWith(
        null,
        "新模板",
        "# 测试内容",
        "测试描述"
      )
    );
  });

  it("编辑对话框预填并调用 upsertPrompt", async () => {
    mockedApi.listPrompts.mockResolvedValue([
      prompt("p1", { name: "旧模板", content: "# 旧内容", description: "旧描述" }),
    ]);
    render(<PromptsPage />);
    await waitFor(() => expect(screen.getByText("旧模板")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      await screen.findByRole("heading", { name: "编辑 Prompt" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("旧模板")).toBeInTheDocument();
    expect(screen.getByDisplayValue("# 旧内容")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^内容/), {
      target: { value: "# 新内容" },
    });
    // DSH 改造后页脚按钮为「应用」（FormFooter 默认），旧断言「保存」属于本次修正
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    await waitFor(() =>
      expect(api.upsertPrompt).toHaveBeenCalledWith(
        "p1",
        "旧模板",
        "# 新内容",
        "旧描述"
      )
    );
  });

  it("删除走确认对话框并调用 deletePrompt", async () => {
    mockedApi.listPrompts.mockResolvedValue([prompt("p1", { name: "待删除" })]);
    render(<PromptsPage />);
    await waitFor(() => expect(screen.getByText("待删除")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除 Prompt" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.deletePrompt).toHaveBeenCalledWith("p1"));
  });

  it("新增对话框 pristine：应用禁用且无行内错误（role=alert）", async () => {
    render(<PromptsPage />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    expect(
      await screen.findByRole("heading", { name: "新增 Prompt" })
    ).toBeInTheDocument();

    // DSH touched 语义：pristine 不喊错，仅应用禁用
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("必填字段失焦后出现行内错误；补全后应用恢复可用", async () => {
    render(<PromptsPage />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await screen.findByRole("heading", { name: "新增 Prompt" });

    fireEvent.blur(screen.getByLabelText(/^名称/));
    expect(screen.getByText("名称不能为空")).toHaveAttribute("role", "alert");
    fireEvent.blur(screen.getByLabelText(/^内容/));
    expect(screen.getByText("内容不能为空")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "新模板" },
    });
    fireEvent.change(screen.getByLabelText(/^内容/), {
      target: { value: "# 测试内容" },
    });
    expect(screen.getByRole("button", { name: "应用" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("提交中：应用显示「应用中」且取消禁用，成功后关闭弹框", async () => {
    render(<PromptsPage />);
    await waitFor(() => expect(api.listPrompts).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await screen.findByRole("heading", { name: "新增 Prompt" });
    fireEvent.change(screen.getByLabelText(/^名称/), {
      target: { value: "新模板" },
    });
    fireEvent.change(screen.getByLabelText(/^内容/), {
      target: { value: "# 测试内容" },
    });

    let resolveSave!: (v: Prompt) => void;
    mockedApi.upsertPrompt.mockImplementationOnce(
      () => new Promise<Prompt>((res) => { resolveSave = res; })
    );

    fireEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(screen.getByRole("button", { name: "应用中" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    resolveSave(prompt("p1"));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "新增 Prompt" })
      ).not.toBeInTheDocument()
    );
  });
});
