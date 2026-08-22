import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileUp, Library, RefreshCw, Search, Settings2 } from "lucide-react";
import { api } from "../lib/api";
import type {
  Channel,
  KbDocument,
  KnowledgeBase,
  RagSettings,
  RetrievedChunk,
} from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

/** radix Select 不允许空字符串 item 值，用哨兵值表示“不指定”。 */
const NONE = "__none__";

/** 文件大小人类可读：B / KB / MB / GB。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "< 1KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[i]}`;
}

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
  const [pending, setPending] = useState(false);

  const [editing, setEditing] = useState<KnowledgeBase | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editChannelId, setEditChannelId] = useState("");
  const [editModel, setEditModel] = useState("");

  const [deletingKb, setDeletingKb] = useState<KnowledgeBase | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<KbDocument | null>(null);

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
        toast.success("知识库已创建");
        loadKbs();
      })
      .catch(handleError);
  };

  const openEdit = (kb: KnowledgeBase) => {
    setEditing(kb);
    setEditName(kb.name);
    setEditChannelId(kb.embedding_channel_id ?? "");
    setEditModel(kb.embedding_model);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = editName.trim();
    if (!name) {
      setError("名称不能为空");
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (name !== editing.name) {
        await api.renameKb(editing.id, name);
      }
      await api.updateKbEmbeddingChannel(
        editing.id,
        editChannelId || null,
        editModel.trim()
      );
      setEditOpen(false);
      setEditing(null);
      toast.success("知识库已更新");
      loadKbs();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const toggleKb = (kb: KnowledgeBase) => {
    setError(null);
    api
      .setKbStatus(kb.id, !kb.enabled)
      .then(() => {
        toast.success(kb.enabled ? "已禁用" : "已启用");
        loadKbs();
      })
      .catch(handleError);
  };

  const confirmDeleteKb = async () => {
    if (!deletingKb) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteKb(deletingKb.id);
      if (selectedKbId === deletingKb.id) setSelectedKbId(null);
      setDeletingKb(null);
      toast.success("知识库已删除");
      loadKbs();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const reindexKb = (kb: KnowledgeBase) => {
    setError(null);
    api
      .reindexKb(kb.id)
      .then(() => {
        toast.success("索引重建中");
        loadKbs();
      })
      .catch(handleError);
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
          .then(() => {
            toast.success(`已上传 ${file.name}`);
            loadDocuments(selectedKbId);
          })
          .catch(handleError);
      };
      reader.onerror = () => handleError(new Error(`读取文件失败: ${file.name}`));
      reader.readAsDataURL(file);
    });
  };

  const confirmDeleteDoc = async () => {
    if (!deletingDoc) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteDocument(deletingDoc.id);
      setDeletingDoc(null);
      toast.success("文档已删除");
      if (selectedKbId) loadDocuments(selectedKbId);
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
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
    <div>
      <PageHeader
        title="知识库"
        description="管理知识库、上传文档、测试检索并配置 RAG 注入"
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 库管理 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Library className="h-4 w-4 text-muted-foreground" />
            库管理
          </CardTitle>
          <CardDescription>创建知识库并配置 Embedding 渠道与模型</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-border bg-muted/40 p-4 sm:grid-cols-2 lg:grid-cols-6">
            <div className="space-y-1.5">
              <Label htmlFor="kb-name">名称</Label>
              <Input
                id="kb-name"
                placeholder="知识库名称"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-desc">描述</Label>
              <Input
                id="kb-desc"
                placeholder="描述（可选）"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Embedding 渠道</Label>
              <Select
                value={form.embedding_channel_id || NONE}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    embedding_channel_id: v === NONE ? "" : v,
                  })
                }
              >
                <SelectTrigger aria-label="Embedding 渠道">
                  <SelectValue placeholder="不指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不指定</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-model">Embedding 模型</Label>
              <Input
                id="kb-model"
                placeholder="Embedding 模型"
                value={form.embedding_model}
                onChange={(e) =>
                  setForm({ ...form, embedding_model: e.target.value })
                }
              />
            </div>
            <div className="flex items-end">
              <Button className="w-full" onClick={createKb}>
                新建
              </Button>
            </div>
          </div>

          {kbs.length === 0 ? (
            <EmptyState
              title="暂无知识库"
              description="还没有创建任何知识库，填写上方表单创建一个吧"
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">文档数</th>
                    <th className="px-4 py-3 font-medium">分块数</th>
                    <th className="px-4 py-3 font-medium">Embedding 渠道</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {kbs.map((kb) => (
                    <tr
                      key={kb.id}
                      className={`cursor-pointer border-b border-border last:border-0 hover:bg-accent/50 ${
                        selectedKbId === kb.id ? "bg-accent/60" : ""
                      }`}
                      onClick={() => setSelectedKbId(kb.id)}
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {kb.name}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {kb.doc_count}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {kb.chunk_count}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {channelName(kb.embedding_channel_id)}
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Switch
                            aria-label={`启用 ${kb.name}`}
                            checked={kb.enabled}
                            onCheckedChange={() => toggleKb(kb)}
                          />
                          <Badge variant={kb.enabled ? "default" : "secondary"}>
                            {kb.enabled ? "启用" : "禁用"}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="flex items-center gap-3"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="text-primary hover:underline"
                            onClick={() => openEdit(kb)}
                          >
                            编辑
                          </button>
                          {kb.needs_reindex && (
                            <button
                              className="inline-flex items-center gap-1 text-amber-600 hover:underline"
                              onClick={() => reindexKb(kb)}
                            >
                              <RefreshCw className="h-3 w-3" />
                              重建索引
                            </button>
                          )}
                          <button
                            className="text-destructive hover:underline"
                            onClick={() => setDeletingKb(kb)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 文档管理 */}
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="h-4 w-4 text-muted-foreground" />
              文档管理
            </CardTitle>
            <CardDescription>
              {selectedKbId
                ? `上传文档到「${kbs.find((k) => k.id === selectedKbId)?.name ?? ""}」`
                : "先在上方选择一个知识库，再上传文档"}
            </CardDescription>
          </div>
          <label className="inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            <FileUp className="h-4 w-4" />
            上传文档
            <input
              type="file"
              multiple
              aria-label="上传文档"
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
        </CardHeader>
        <CardContent>
          {!selectedKbId ? (
            <p className="text-sm text-muted-foreground">
              请先在库管理中选择一个知识库。
            </p>
          ) : documents.length === 0 ? (
            <EmptyState
              title="暂无文档"
              description="当前知识库还没有文档，点击右上角“上传文档”添加"
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">文件名</th>
                    <th className="px-4 py-3 font-medium">类型</th>
                    <th className="px-4 py-3 font-medium">大小</th>
                    <th className="px-4 py-3 font-medium">分块数</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">错误</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr
                      key={doc.id}
                      className="border-b border-border last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {doc.filename}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {doc.file_type}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatBytes(doc.size_bytes)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {doc.chunk_count}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            doc.status === "completed" ? "default" : "secondary"
                          }
                        >
                          {doc.status}
                        </Badge>
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-3 text-muted-foreground">
                        {doc.error ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="text-destructive hover:underline"
                          onClick={() => setDeletingDoc(doc)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 检索测试 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Search className="h-4 w-4 text-muted-foreground" />
            检索测试
          </CardTitle>
          <CardDescription>
            对当前选中的知识库执行相似度检索，验证切片与 Embedding 效果
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Input
              placeholder="输入检索内容"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <Button onClick={search}>
              <Search className="h-4 w-4" />
              检索
            </Button>
          </div>
          {chunks.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无检索结果。</p>
          ) : (
            <ul className="space-y-2">
              {chunks.map((c) => (
                <li
                  key={c.embedding_id}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {c.filename}
                    </span>
                    {c.symbol && <span className="font-mono">{c.symbol}</span>}
                    <Badge variant="secondary">分数 {c.score.toFixed(4)}</Badge>
                  </div>
                  <div className="whitespace-pre-wrap">{c.content}</div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* RAG 设置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            RAG 设置
          </CardTitle>
          <CardDescription>
            开启后，进入网关的请求会自动检索知识库并注入到系统提示中
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">启用 RAG</div>
                <div className="text-xs text-muted-foreground">
                  请求时自动检索并注入相关文档片段
                </div>
              </div>
              <Switch
                aria-label="启用 RAG"
                checked={rag.enabled}
                onCheckedChange={(checked) => updateRag("enabled", checked)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>默认知识库</Label>
              <Select
                value={rag.default_kb ?? NONE}
                onValueChange={(v) =>
                  updateRag("default_kb", v === NONE ? null : v)
                }
              >
                <SelectTrigger aria-label="默认知识库">
                  <SelectValue placeholder="不指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不指定</SelectItem>
                  {kbs.map((kb) => (
                    <SelectItem key={kb.id} value={kb.id}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>默认 Embedding 渠道</Label>
              <Select
                value={rag.default_embedding_channel ?? NONE}
                onValueChange={(v) =>
                  updateRag(
                    "default_embedding_channel",
                    v === NONE ? null : v
                  )
                }
              >
                <SelectTrigger aria-label="默认 Embedding 渠道">
                  <SelectValue placeholder="不指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不指定</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 编辑知识库对话框 */}
      <Dialog
        open={editOpen}
        onOpenChange={(next) => {
          if (!next) {
            setEditOpen(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑知识库</DialogTitle>
            <DialogDescription>修改名称与 Embedding 配置后保存</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-kb-name">名称</Label>
              <Input
                id="edit-kb-name"
                placeholder="知识库名称"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Embedding 渠道</Label>
              <Select
                value={editChannelId || NONE}
                onValueChange={(v) =>
                  setEditChannelId(v === NONE ? "" : v)
                }
              >
                <SelectTrigger aria-label="编辑 Embedding 渠道">
                  <SelectValue placeholder="不指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>不指定</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-kb-model">Embedding 模型</Label>
              <Input
                id="edit-kb-model"
                placeholder="Embedding 模型"
                value={editModel}
                onChange={(e) => setEditModel(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={saveEdit} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingKb !== null}
        title="删除知识库"
        message={
          deletingKb
            ? `确定删除知识库「${deletingKb.name}」?库下文档与索引将一并删除。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeletingKb(null)}
        onConfirm={confirmDeleteKb}
      />

      <ConfirmDialog
        open={deletingDoc !== null}
        title="删除文档"
        message={
          deletingDoc ? `确定删除文档「${deletingDoc.filename}」?` : undefined
        }
        pending={pending}
        onCancel={() => setDeletingDoc(null)}
        onConfirm={confirmDeleteDoc}
      />
    </div>
  );
}
