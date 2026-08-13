import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import KnowledgePage from "../KnowledgePage";
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
});
