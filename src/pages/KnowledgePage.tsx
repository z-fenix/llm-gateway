import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type {
  Channel,
  KbDocument,
  KnowledgeBase,
  RagSettings,
  RetrievedChunk,
} from "../types";

export default function KnowledgePage() {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [chunks, setChunks] = useState<RetrievedChunk[]>([]);
  const [rag, setRag] = useState<RagSettings>({
    enabled: false,
    default_kb: null,
    default_embedding_channel: null,
  });
  const [form, setForm] = useState({
    name: "",
    description: "",
    embedding_channel_id: "",
    embedding_model: "",
  });
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const channelName = (id: string | null) =>
    channels.find((c) => c.id === id)?.name ?? id ?? "-";

  const loadKbs = () => {
    setError(null);
    api
      .listKbs()
      .then((list) => {
        setKbs(list);
        setSelectedKbId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(handleError);
  };

  const loadDocuments = (kbId: string) => {
    setError(null);
    api.listDocuments(kbId).then(setDocuments).catch(handleError);
  };

  useEffect(() => {
    setError(null);
    loadKbs();
    api.listChannels().then(setChannels).catch(handleError);
    api.getRagSettings().then(setRag).catch(handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedKbId) loadDocuments(selectedKbId);
    else setDocuments([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKbId]);

  const createKb = () => {
    const name = form.name.trim();
    if (!name) {
      setError("请输入知识库名称");
      return;
    }
    setError(null);
    api
      .createKb(
        name,
        form.description.trim() || null,
        form.embedding_channel_id || null,
        form.embedding_model.trim()
      )
      .then(() => {
        setForm({
          name: "",
          description: "",
          embedding_channel_id: "",
          embedding_model: "",
        });
        loadKbs();
      })
      .catch(handleError);
  };

  const deleteKb = (kb: KnowledgeBase) => {
    if (!window.confirm(`确定删除知识库「${kb.name}」?库下文档与索引将一并删除。`)) return;
    setError(null);
    api
      .deleteKb(kb.id)
      .then(() => {
        if (selectedKbId === kb.id) setSelectedKbId(null);
        loadKbs();
      })
      .catch(handleError);
  };

  const reindexKb = (kb: KnowledgeBase) => {
    setError(null);
    api.reindexKb(kb.id).then(loadKbs).catch(handleError);
  };

  const onFiles = (files: FileList | null) => {
    if (!selectedKbId) {
      setError("请先选择知识库");
      return;
    }
    if (!files || files.length === 0) return;
    setError(null);
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
        api
          .uploadDocument(selectedKbId, file.name, base64)
          .then(() => loadDocuments(selectedKbId))
          .catch(handleError);
      };
      reader.onerror = () => handleError(new Error(`读取文件失败: ${file.name}`));
      reader.readAsDataURL(file);
    });
  };

  const deleteDocument = (doc: KbDocument) => {
    if (!window.confirm(`确定删除文档「${doc.filename}」?`)) return;
    setError(null);
    api
      .deleteDocument(doc.id)
      .then(() => selectedKbId && loadDocuments(selectedKbId))
      .catch(handleError);
  };

  const search = () => {
    if (!selectedKbId) {
      setError("请先选择知识库");
      return;
    }
    const q = query.trim();
    if (!q) {
      setError("请输入检索内容");
      return;
    }
    setError(null);
    api.searchKb(selectedKbId, q).then(setChunks).catch(handleError);
  };

  const updateRag = (
    key: keyof RagSettings,
    value: boolean | string | null
  ) => {
    setError(null);
    api
      .setRagSetting(key, value)
      .then(() => setRag((prev) => ({ ...prev, [key]: value })))
      .catch(handleError);
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <div>
        <h1 className="mb-2 text-xl font-bold">知识库</h1>
        <p className="mb-3 text-sm text-gray-500">
          管理知识库、上传文档、测试检索并配置 RAG 注入。
        </p>
      </div>

      {/* 库管理 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">库管理</h2>
        <div className="mb-4 grid grid-cols-1 gap-2 rounded border bg-gray-50 p-3 sm:grid-cols-2 lg:grid-cols-6">
          <input
            className="border rounded px-2 py-1"
            placeholder="知识库名称"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="border rounded px-2 py-1"
            placeholder="描述（可选）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <select
            className="border rounded px-2 py-1"
            aria-label="Embedding 渠道"
            value={form.embedding_channel_id}
            onChange={(e) =>
              setForm({ ...form, embedding_channel_id: e.target.value })
            }
          >
            <option value="">不指定</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            className="border rounded px-2 py-1"
            placeholder="Embedding 模型"
            value={form.embedding_model}
            onChange={(e) =>
              setForm({ ...form, embedding_model: e.target.value })
            }
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-white"
            onClick={createKb}
          >
            新建
          </button>
        </div>

        <table className="w-full border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">名称</th>
              <th>文档数</th>
              <th>分块数</th>
              <th>Embedding 渠道</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {kbs.map((kb) => (
              <tr
                key={kb.id}
                className={`cursor-pointer border-b ${selectedKbId === kb.id ? "bg-blue-50" : ""}`}
                onClick={() => setSelectedKbId(kb.id)}
              >
                <td className="p-2">{kb.name}</td>
                <td>{kb.doc_count}</td>
                <td>{kb.chunk_count}</td>
                <td>{channelName(kb.embedding_channel_id)}</td>
                <td>{kb.enabled ? "启用" : "禁用"}</td>
                <td className="space-x-2" onClick={(e) => e.stopPropagation()}>
                  {kb.needs_reindex && (
                    <button
                      className="text-amber-600"
                      onClick={() => reindexKb(kb)}
                    >
                      重建索引
                    </button>
                  )}
                  <button
                    className="text-red-600"
                    onClick={() => deleteKb(kb)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 文档管理 */}
      <div className="rounded border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">文档管理</h2>
          <label className="cursor-pointer rounded bg-blue-600 px-3 py-1 text-sm text-white">
            上传文档
            <input
              type="file"
              multiple
              aria-label="上传文档"
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
        </div>
        {!selectedKbId && (
          <p className="text-sm text-gray-400">请先在库管理中选择一个知识库。</p>
        )}
        {selectedKbId && (
          <table className="w-full border bg-white text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">文件名</th>
                <th>类型</th>
                <th>大小</th>
                <th>分块数</th>
                <th>状态</th>
                <th>错误</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-b">
                  <td className="p-2">{doc.filename}</td>
                  <td>{doc.file_type}</td>
                  <td>{doc.size_bytes}</td>
                  <td>{doc.chunk_count}</td>
                  <td>{doc.status}</td>
                  <td className="max-w-[160px] truncate">{doc.error ?? "-"}</td>
                  <td>
                    <button
                      className="text-red-600"
                      onClick={() => deleteDocument(doc)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 检索测试 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">检索测试</h2>
        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 border rounded px-2 py-1"
            placeholder="输入检索内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-white"
            onClick={search}
          >
            检索
          </button>
        </div>
        {chunks.length === 0 ? (
          <p className="text-sm text-gray-400">暂无检索结果。</p>
        ) : (
          <ul className="space-y-2">
            {chunks.map((c) => (
              <li key={c.embedding_id} className="rounded border p-3 text-sm">
                <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
                  <span>{c.filename}</span>
                  {c.symbol && <span className="font-mono">{c.symbol}</span>}
                  <span>分数 {c.score.toFixed(4)}</span>
                </div>
                <div className="whitespace-pre-wrap">{c.content}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* RAG 设置 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">RAG 设置</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              aria-label="启用 RAG"
              checked={rag.enabled}
              onChange={(e) => updateRag("enabled", e.target.checked)}
            />
            启用 RAG
          </label>
          <label className="flex items-center gap-2 text-sm">
            默认知识库
            <select
              className="border rounded px-2 py-1"
              aria-label="默认知识库"
              value={rag.default_kb ?? ""}
              onChange={(e) => updateRag("default_kb", e.target.value || null)}
            >
              <option value="">不指定</option>
              {kbs.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            默认 Embedding 渠道
            <select
              className="border rounded px-2 py-1"
              aria-label="默认 Embedding 渠道"
              value={rag.default_embedding_channel ?? ""}
              onChange={(e) =>
                updateRag("default_embedding_channel", e.target.value || null)
              }
            >
              <option value="">不指定</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
