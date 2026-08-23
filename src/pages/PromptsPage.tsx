import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText, Plus } from "lucide-react";
import { api } from "../lib/api";
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
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);

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

  return (
    <div>
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

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 Prompt" : "新增 Prompt"}</DialogTitle>
            <DialogDescription>
              {editing ? "修改模板内容后保存" : "填写名称与 CLAUDE.md 模板内容"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="prompt-name">名称</Label>
              <Input
                id="prompt-name"
                placeholder="例如：默认开发模板"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-description">描述</Label>
              <Input
                id="prompt-description"
                placeholder="简要说明这套 Prompt 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-content">内容</Label>
              <textarea
                id="prompt-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="在此输入 CLAUDE.md 内容..."
                className="min-h-[320px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              />
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={closeDialog} disabled={pending}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {list.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title="暂无 Prompt"
          description="创建一套 Prompt 模板，启用后会写入 ~/.claude/CLAUDE.md"
        >
          <Button onClick={openCreate}>新增 Prompt</Button>
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">描述</th>
                <th className="px-4 py-3 font-medium">启用</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {p.name}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.description ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={p.enabled}
                      onCheckedChange={() => handleEnable(p)}
                      aria-label={`启用 ${p.name}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => openEdit(p)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-destructive hover:underline"
                        onClick={() => setDeleting(p)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
