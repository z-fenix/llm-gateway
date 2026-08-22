import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import KnowledgePage, { formatBytes } from "../KnowledgePage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    listKbs: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listDocuments: vi.fn().mockResolvedValue([]),
    getRagSettings: vi.fn().mockResolvedValue({
      enabled: false,
      default_kb: null,
      default_embedding_channel: null,
    }),
    createKb: vi.fn().mockResolvedValue({}),
    setKbStatus: vi.fn().mockResolvedValue(undefined),
    renameKb: vi.fn().mockResolvedValue(undefined),
    updateKbEmbeddingChannel: vi.fn().mockResolvedValue(undefined),
    deleteKb: vi.fn().mockResolvedValue(undefined),
    reindexKb: vi.fn().mockResolvedValue(undefined),
    uploadDocument: vi.fn().mockResolvedValue({}),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
    searchKb: vi.fn().mockResolvedValue([]),
    setRagSetting: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockedApi = vi.mocked(api);

const kb = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "kb1",
    name: "文档库",
    description: null,
    embedding_channel_id: null,
    embedding_model: "text-embedding-3-small",
    dim: 0,
    doc_count: 3,
    chunk_count: 12,
    enabled: true,
    created_at: 1,
    updated_at: 1,
    needs_reindex: false,
    ...overrides,
  }) as any;

describe("formatBytes", () => {
  it("格式化文件大小为人类可读形式", () => {
    expect(formatBytes(0)).toBe("< 1KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1258)).toBe("1.2 KB");
    expect(formatBytes(3565158)).toBe("3.4 MB");
  });
});

describe("KnowledgePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("渲染知识库列表", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getAllByText("文档库").length).toBeGreaterThan(0)
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("新建库调用 createKb", async () => {
    mockedApi.listChannels.mockResolvedValue([
      { id: "ch1", name: "渠道A" } as any,
    ]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("知识库名称")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByPlaceholderText("知识库名称"), {
      target: { value: "新库" },
    });
    fireEvent.change(screen.getByPlaceholderText("Embedding 模型"), {
      target: { value: "text-embedding-3-small" },
    });
    fireEvent.click(screen.getByText("新建"));
    await waitFor(() =>
      expect(mockedApi.createKb).toHaveBeenCalledWith(
        "新库",
        null,
        null,
        "text-embedding-3-small"
      )
    );
  });

  it("上传文件调用 uploadDocument(base64)", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByLabelText("上传文档")).toBeInTheDocument()
    );
    const input = screen.getByLabelText("上传文档") as HTMLInputElement;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(mockedApi.uploadDocument).toHaveBeenCalled());
    expect(mockedApi.uploadDocument).toHaveBeenCalledWith(
      "kb1",
      "a.txt",
      "aGVsbG8="
    );
  });

  it("检索测试显示片段", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    mockedApi.searchKb.mockResolvedValue([
      {
        embedding_id: 1,
        content: "片段内容",
        symbol: "func",
        filename: "a.go",
        score: 0.9,
      },
    ]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("输入检索内容")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByPlaceholderText("输入检索内容"), {
      target: { value: "查询词" },
    });
    fireEvent.click(screen.getByText("检索"));
    await waitFor(() =>
      expect(mockedApi.searchKb).toHaveBeenCalledWith("kb1", "查询词")
    );
    expect(screen.getByText("a.go")).toBeInTheDocument();
    expect(screen.getByText("片段内容")).toBeInTheDocument();
  });

  it("RAG 开关改动调用 setRagSetting", async () => {
    mockedApi.getRagSettings.mockResolvedValue({
      enabled: true,
      default_kb: null,
      default_embedding_channel: null,
    });
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByLabelText("启用 RAG")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByLabelText("启用 RAG"));
    await waitFor(() =>
      expect(mockedApi.setRagSetting).toHaveBeenCalledWith("enabled", false)
    );
  });

  it("needs_reindex=true 时显示重建索引按钮", async () => {
    mockedApi.listKbs.mockResolvedValue([kb({ needs_reindex: true })]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByText("重建索引")).toBeInTheDocument()
    );
  });

  it("needs_reindex=false 时不显示重建索引按钮", async () => {
    mockedApi.listKbs.mockResolvedValue([kb({ needs_reindex: false })]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getAllByText("文档库").length).toBeGreaterThan(0)
    );
    expect(screen.queryByText("重建索引")).not.toBeInTheDocument();
  });

  it("点击重建索引调用 reindexKb", async () => {
    mockedApi.listKbs.mockResolvedValue([kb({ needs_reindex: true })]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByText("重建索引")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("重建索引"));
    await waitFor(() =>
      expect(mockedApi.reindexKb).toHaveBeenCalledWith("kb1")
    );
  });

  it("切换启用开关调用 setKbStatus", async () => {
    mockedApi.listKbs.mockResolvedValue([kb({ enabled: true })]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getAllByRole("switch").length).toBeGreaterThan(0)
    );
    // 第一个 switch 是知识库启用开关（RAG 开关在其后）
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await waitFor(() =>
      expect(mockedApi.setKbStatus).toHaveBeenCalledWith("kb1", false)
    );
  });

  it("编辑知识库对话框预填并保存调用 renameKb + updateKbEmbeddingChannel", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      await screen.findByRole("heading", { name: "编辑知识库" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("文档库")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("text-embedding-3-small")
    ).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("文档库"), {
      target: { value: "新名字" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedApi.renameKb).toHaveBeenCalledWith("kb1", "新名字")
    );
    expect(mockedApi.updateKbEmbeddingChannel).toHaveBeenCalledWith(
      "kb1",
      null,
      "text-embedding-3-small"
    );
  });

  it("编辑仅改模型时只调用 updateKbEmbeddingChannel", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await screen.findByRole("heading", { name: "编辑知识库" });
    fireEvent.change(screen.getByDisplayValue("text-embedding-3-small"), {
      target: { value: "text-embedding-3-large" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockedApi.updateKbEmbeddingChannel).toHaveBeenCalledWith(
        "kb1",
        null,
        "text-embedding-3-large"
      )
    );
    expect(mockedApi.renameKb).not.toHaveBeenCalled();
  });

  it("删除知识库走确认对话框并调用 deleteKb", async () => {
    mockedApi.listKbs.mockResolvedValue([kb()]);
    render(<KnowledgePage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除知识库" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(mockedApi.deleteKb).toHaveBeenCalledWith("kb1")
    );
  });
});
