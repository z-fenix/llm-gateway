import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText, Plus } from "lucide-react";
import { api } from "../lib/api";
import { FOCUS_RING } from "../lib/focusRing";
import type { Prompt } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

/** Prompt 弹框行内校验（前端与后端同一套规则：名称/内容必填，后端为准）。 */
type PromptField = "name" | "description" | "content";

function validatePromptForm(
  name: string,
  content: string
): Partial<Record<"name" | "content", string>> {
  const errs: Partial<Record<"name" | "content", string>> = {};
  if (!name.trim()) errs.name = "名称不能为空";
  if (!content.trim()) errs.content = "内容不能为空";
  return errs;
}

export default function PromptsPage() {
  const [list, setList] = useState<Prompt[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  // DSH touched 语义：pristine 空表单不喊错——行内错误仅「字段被触碰（blur/onChange）且无效」
  // 或「曾尝试提交」时渲染；应用按钮仍按原始校验态禁用（不受 touched 影响）。
  const [touched, setTouched] = useState<Partial<Record<PromptField, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const errors = validatePromptForm(name, content);
  const formValid = Object.keys(errors).length === 0;
  const touch = (k: PromptField) =>
    setTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const showErr = (k: "name" | "content") =>
    touched[k] || submitAttempted ? errors[k] : undefined;

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
    setTouched({});
    setSubmitAttempted(false);
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
    setTouched({});
    setSubmitAttempted(false);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  const handleSave = async () => {
    setSubmitAttempted(true);
    if (pending) return;
    if (!formValid) return; // 应用已禁用，此处双保险（行内校验为准，不再走 toast 报错）
    setError(null);
    setPending(true);
    try {
      await api.upsertPrompt(
        editing ? editing.id : null,
        name.trim(),
        content.trim(),
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
            <FormField label="名称" htmlFor="prompt-name" required error={showErr("name")}>
              <Input
                id="prompt-name"
                placeholder="例如：默认开发模板"
                value={name}
                onBlur={() => touch("name")}
                onChange={(e) => {
                  touch("name");
                  setName(e.target.value);
                }}
              />
            </FormField>
            <FormField label="描述" htmlFor="prompt-description">
              <Input
                id="prompt-description"
                placeholder="简要说明这套 Prompt 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <FormField label="内容" htmlFor="prompt-content" required error={showErr("content")}>
              <textarea
                id="prompt-content"
                value={content}
                onBlur={() => touch("content")}
                onChange={(e) => {
                  touch("content");
                  setContent(e.target.value);
                }}
                placeholder="在此输入 CLAUDE.md 内容..."
                className="min-h-[320px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              />
            </FormField>
          </div>
          {/* 页脚：左取消右应用；busy 文案「应用中」；校验不过禁用应用 */}
          <FormFooter
            onCancel={closeDialog}
            onSubmit={handleSave}
            busy={pending}
            submitDisabled={!formValid}
          />
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
                        className={`text-primary hover:underline ${FOCUS_RING}`}
                        onClick={() => openEdit(p)}
                      >
                        编辑
                      </button>
                      <button
                        className={`text-destructive hover:underline ${FOCUS_RING}`}
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
