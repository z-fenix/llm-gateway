import { DialogBody } from "../components/ui/dialog";
import { FOCUS_RING } from "../lib/focusRing";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText, Plus } from "lucide-react";
import { api } from "../lib/api";
import { useFormValidation } from "../lib/useFormValidation";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
import type { Prompt } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export default function PromptsPage() {
  const [list, setList] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const formValidation = useFormValidation({ name: name.trim() ? undefined : "名称不能为空", content: content.trim() ? undefined : "内容不能为空" });
  const [draft, setDraft] = useState<string | null>(null);
  const [enableTarget, setEnableTarget] = useState<Prompt | null>(null);

  const [deleting, setDeleting] = useState<Prompt | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
    toast.error(msg);
  };

  const load = () => {
    setError(null);
    api.listPrompts().then(setList).catch(handleError);
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    formValidation.reset();
    setName("");
    setDescription("");
    setContent("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (p: Prompt) => {
    setEditing(p);
    setName(p.name);
    setDescription(p.description ?? "");
    setContent(p.content);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  const handleSave = async () => {
    if (pending || formValidation.invalid) return;
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (!trimmedName) {
      toast.error("名称不能为空");
      return;
    }
    if (!trimmedContent) {
      toast.error("内容不能为空");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await api.upsertPrompt(
        editing ? editing.id : null,
        trimmedName,
        trimmedContent,
        description.trim() || null
      );
      toast.success(editing ? "Prompt 已更新" : "Prompt 已创建");
      closeDialog();
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const handleEnable = (p: Prompt) => {
    setError(null);
    api
      .enablePrompt(p.id)
      .then(() => {
        toast.success("已写入 ~/.claude/CLAUDE.md");
        load();
      })
      .catch(handleError);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError(null);
    setPending(true);
    try {
      await api.deletePrompt(deleting.id);
      setDeleting(null);
      toast.success("Prompt 已删除");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const selected = list.find((p) => p.id === selectedId) ?? list[0];
  const saveDraft = async () => {
    if (!selected || pending || !draft?.trim()) return;
    setPending(true);
    try {
      await api.upsertPrompt(selected.id, selected.name, draft, selected.description);
      setList((items) => items.map((p) => p.id === selected.id ? { ...p, content: draft } : p));
      setDraft(null);
      toast.success("模板已保存，启用状态未改变");
    } catch (err) { handleError(err); } finally { setPending(false); }
  };

  return (
    <div className="page-stack" id="prompts">
      <PageHeader
        title="Prompt 管理"
        description="多套 CLAUDE.md 模板，启用后写入 ~/.claude/CLAUDE.md（自动备份）"
        action={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新增
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && !pending && closeDialog()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 Prompt" : "新增 Prompt"}</DialogTitle>
            <DialogDescription>
              {editing ? "修改模板内容后保存" : "填写名称与 CLAUDE.md 模板内容"}
            </DialogDescription>
          </DialogHeader>

<DialogBody className="space-y-5"><div className="space-y-4">
            <FormField label="名称" htmlFor="prompt-name" error={formValidation.errors.name}>
<Input
                id="prompt-name" onBlur={() => formValidation.touch("name")} aria-invalid={!!formValidation.errors.name}
                placeholder="例如：默认开发模板"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
</FormField>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-description">描述</Label>
              <Input
                id="prompt-description"
                placeholder="简要说明这套 Prompt 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <FormField label="内容" htmlFor="prompt-content" error={formValidation.errors.content}>
<textarea
                id="prompt-content" onBlur={() => formValidation.touch("content")} aria-invalid={!!formValidation.errors.content}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="在此输入 CLAUDE.md 内容..."
                className="min-h-[320px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              />
</FormField>
          </div></DialogBody>

          <FormFooter onCancel={closeDialog} onSubmit={handleSave} busy={pending} submitDisabled={formValidation.invalid} />
        </DialogContent>
      </Dialog>

      <div className="info-banner"><div><h2 className="text-[13px] font-medium">全局模板 · 仅启用一套</h2><p className="mt-1.5 text-xs text-muted-foreground">启用后写入 ~/.claude/CLAUDE.md，原文件会自动备份。</p></div></div>
      {list.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title="暂无 Prompt"
          description="创建一套 Prompt 模板，启用后会写入 ~/.claude/CLAUDE.md"
        >
          <Button onClick={openCreate}>新增 Prompt</Button>
        </EmptyState>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[292px_minmax(0,1fr)]">
          <Card className="space-y-3 p-4"><p className="px-1 py-2 text-sm font-semibold">我的模板</p>{list.map((p) => <div key={p.id} className={`rounded-xl p-4 ${selected?.id === p.id ? "bg-accent" : "bg-background"}`}>
            <button className="w-full text-left" onClick={() => { if (pending || (draft !== null && draft !== selected.content && !window.confirm("切换模板将放弃未保存的修改，是否继续？"))) return; setSelectedId(p.id); setDraft(null); }}><p className="text-sm font-medium">{p.name}</p><p className="mt-2 text-xs text-muted-foreground">{p.description ?? "暂无描述"}</p></button>
            <div className="mt-3 flex items-center justify-between gap-2"><Switch checked={p.enabled} disabled={p.enabled || pending} onCheckedChange={() => setEnableTarget(p)} aria-label={`启用 ${p.name}`} /><div className="flex gap-3 text-xs"><button className={`text-primary hover:underline ${FOCUS_RING}`} onClick={() => openEdit(p)}>编辑</button><button className={`text-destructive hover:underline ${FOCUS_RING}`} onClick={() => setDeleting(p)}>删除</button></div></div>
          </div>)}</Card>
          <Card className="min-w-0 space-y-5 p-6"><div className="page-toolbar"><div><h2 className="text-base font-semibold">{selected.name}</h2><p className="mt-2 text-xs text-muted-foreground">CLAUDE.md · 修改后保存，不会自动启用</p></div><Button variant="outline" size="sm" onClick={() => openEdit(selected)}>模板设置</Button></div><textarea aria-label="模板内容" disabled={pending} value={draft ?? selected.content} onChange={(e) => setDraft(e.target.value)} className="min-h-[390px] w-full resize-y border-0 bg-background font-mono text-xs leading-7" spellCheck={false} /><div className="page-toolbar"><span className="text-xs text-muted-foreground">{draft !== null ? "有未保存的修改" : "模板内容已保存"}</span><div className="flex gap-2"><Button variant="outline" onClick={() => setEnableTarget(selected)} disabled={pending || selected.enabled}>{selected.enabled ? "已启用" : "启用模板"}</Button><Button onClick={saveDraft} disabled={pending || draft === null || !draft.trim()}>{pending ? "保存中…" : "保存模板"}</Button></div></div></Card>
        </div>
      )}

      <ConfirmDialog open={!!enableTarget} title="启用全局模板？" message="将写入 ~/.claude/CLAUDE.md，原文件自动备份，同时只启用一套模板。未保存的编辑不会写入。" onCancel={() => setEnableTarget(null)} onConfirm={() => { if (enableTarget) handleEnable(enableTarget); setEnableTarget(null); }} />
      <ConfirmDialog
        open={deleting !== null}
        title="删除 Prompt"
        message={
          deleting
            ? `确定删除 Prompt「${deleting.name}」吗？启用中的 Prompt 删除前请先切换其他模板。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
