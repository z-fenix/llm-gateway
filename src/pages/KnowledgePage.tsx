import { DialogBody } from "../components/ui/dialog";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileUp, Library, RefreshCw, Search, Settings2 } from "lucide-react";
import { api } from "../lib/api";
import { useFormValidation } from "../lib/useFormValidation";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [ragOpen, setRagOpen] = useState(false);
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
  const createValidation = useFormValidation({ name: form.name.trim() ? undefined : "名称不能为空" });
  const editValidation = useFormValidation({ name: editName.trim() ? undefined : "名称不能为空" });

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
    setPending(true);
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
        setCreateOpen(false);
        toast.success("知识库已创建");
        loadKbs();
      })
      .catch(handleError)
      .finally(() => setPending(false));
  };

  const openEdit = (kb: KnowledgeBase) => {
    editValidation.reset();
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
      // 页面级 error 横幅位于 Dialog 遮罩之下，用户在弹窗内看不到；改用 toast 在弹窗上方提示
      toast.error("名称不能为空");
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
    <div className="page-stack" id="knowledge">
      <PageHeader
        title="知识库"
        description="管理知识库、上传文档、测试检索并配置 RAG 注入"
        action={<Button onClick={() => { createValidation.reset(); setCreateOpen(true); }}>创建知识库</Button>}
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>创建知识库</DialogTitle><DialogDescription>配置名称与 Embedding 模型后创建知识库。</DialogDescription></DialogHeader>

<DialogBody className="space-y-5">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-border bg-muted/40 p-4 sm:grid-cols-2 lg:grid-cols-2">
            <FormField label="名称" htmlFor="kb-name" error={createValidation.errors.name}>
<Input
                id="kb-name" onBlur={() => createValidation.touch("name")} aria-invalid={!!createValidation.errors.name}
                placeholder="知识库名称"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
</FormField>
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
          </div></DialogBody>
          <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setCreateOpen(false)}>取消</Button><Button onClick={createKb} disabled={pending || createValidation.invalid}>新建</Button></DialogFooter>
      </DialogContent></Dialog>
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="min-h-[442px] p-4"><h2 className="mb-4 px-1 text-sm font-semibold">我的知识库</h2>
          {kbs.length === 0 ? <EmptyState title="暂无知识库" description="创建知识库后上传文档，开始测试检索。"><Button onClick={() => { createValidation.reset(); setCreateOpen(true); }}>新建知识库</Button></EmptyState> : <div className="space-y-2">{kbs.map((kb) => <button key={kb.id} className={`w-full rounded-xl p-3 text-left transition-colors ${selectedKbId === kb.id ? "bg-accent" : "bg-background hover:bg-muted"}`} onClick={() => setSelectedKbId(kb.id)} aria-pressed={selectedKbId === kb.id}><p className="truncate text-sm font-medium">{kb.name}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{kb.doc_count} 份文档 · {kb.chunk_count} 个分块</p></button>)}</div>}
          {kbs.find((kb) => kb.id === selectedKbId) && <details className="mt-4 border-t border-border/60 pt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">知识库设置</summary>{kbs.filter((kb) => kb.id === selectedKbId).map((kb) => <div key={kb.id} className="mt-4 space-y-4"><p className="break-all text-muted-foreground">{channelName(kb.embedding_channel_id)} / {kb.embedding_model}</p><div className="flex items-center justify-between"><span>启用知识库</span><Switch aria-label={`启用 ${kb.name}`} checked={kb.enabled} onCheckedChange={() => toggleKb(kb)} /></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => openEdit(kb)}>编辑</Button>{kb.needs_reindex && <Button variant="outline" size="sm" onClick={() => reindexKb(kb)}>重建索引</Button>}<Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeletingKb(kb)}>删除</Button></div></div>)}</details>}
        </Card>
      {/* 文档管理 */}
      <Card className="min-h-[442px] min-w-0">
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileUp className="h-4 w-4 text-muted-foreground" />
              {kbs.find((kb) => kb.id === selectedKbId)?.name ?? "文档管理"}
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
            <ul className="divide-y divide-border/60">{documents.map((doc) => <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0"><div className="min-w-0 flex-1"><p className="break-all text-[13px] font-medium">{doc.filename}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{doc.file_type.toUpperCase()} · {formatBytes(doc.size_bytes)} · {doc.status === "completed" || doc.status === "ready" ? "已就绪" : doc.status}{doc.error && ` · ${doc.error}`}</p></div><span className="text-xs text-muted-foreground">{doc.chunk_count} 分块</span><Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" aria-label={`删除 ${doc.filename}`} onClick={() => setDeletingDoc(doc)}>删除</Button></li>)}</ul>
          )}
        </CardContent>
      </Card>

      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
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
          <div className="flex gap-2">
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
          {chunks.length === 0 ? null : (
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

      <Card className="p-6"><div className="page-toolbar"><h2 className="text-base font-semibold">自动注入 RAG</h2><Switch aria-label="启用 RAG" checked={rag.enabled} onCheckedChange={(checked) => updateRag("enabled", checked)} /></div><p className="mt-3 text-xs leading-6 text-muted-foreground">默认知识库：{kbs.find((kb) => kb.id === rag.default_kb)?.name ?? "未指定"}<br />将检索结果注入请求系统提示。</p><Button variant="outline" size="sm" className="mt-4" onClick={() => setRagOpen(true)}><Settings2 />配置 RAG</Button></Card>
      <Dialog open={ragOpen} onOpenChange={setRagOpen}><DialogContent><DialogHeader><DialogTitle>RAG 设置</DialogTitle><DialogDescription>设置检索时使用的默认知识库与 Embedding 渠道。</DialogDescription></DialogHeader>
<DialogBody className="space-y-5"><div className="space-y-4">
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

      </div></DialogBody>
</DialogContent></Dialog>

      </div>
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

<DialogBody className="space-y-5"><div className="space-y-4">
            <FormField label="名称" htmlFor="edit-kb-name" error={editValidation.errors.name}>
<Input
                id="edit-kb-name" onBlur={() => editValidation.touch("name")} aria-invalid={!!editValidation.errors.name}
                placeholder="知识库名称"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
</FormField>
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
          </div></DialogBody>

          <FormFooter onCancel={() => setEditOpen(false)} onSubmit={saveEdit} busy={pending} submitDisabled={editValidation.invalid} />
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
