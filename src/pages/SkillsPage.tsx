import { DialogBody } from "../components/ui/dialog";
import { FOCUS_RING } from "../lib/focusRing";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, RefreshCw, Server, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { useFormValidation } from "../lib/useFormValidation";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
import type { InstalledSkill, Skill, SkillView } from "../types";
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
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";

export default function SkillsPage() {
  const [list, setList] = useState<SkillView[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const formValidation = useFormValidation({ name: name.trim() ? undefined : "名称不能为空", directory: directory.trim() ? undefined : "目录不能为空", content: content.trim() ? undefined : "内容不能为空" });

  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [toggleTarget, setToggleTarget] = useState<SkillView | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
    toast.error(msg);
  };

  const load = () => {
    setError(null);
    api.listSkills().then(setList).catch(handleError);
    api.listInstalledSkills().then(setInstalled).catch(handleError);
  };

  useEffect(() => {
    load();
  }, []);

  const handleImport = async (directory: string) => {
    setError(null);
    try {
      await api.importInstalledSkill(directory);
      toast.success("已导入到管理列表");
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const handleSyncMcp = async (directory: string) => {
    setError(null);
    try {
      const n = await api.syncSkillMcp(directory);
      toast.success(`已同步 ${n} 个 MCP server`);
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const resetForm = () => {
    formValidation.reset();
    setName("");
    setDescription("");
    setDirectory("");
    setContent("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (s: Skill) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description ?? "");
    setDirectory(s.directory);
    setContent(s.content);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  const handleSave = async () => {
    if (pending || formValidation.invalid) return;
    const trimmedName = name.trim();
    const trimmedDirectory = directory.trim();
    const trimmedContent = content.trim();
    if (!trimmedName) {
      toast.error("名称不能为空");
      return;
    }
    if (!trimmedDirectory) {
      toast.error("目录不能为空");
      return;
    }
    if (!trimmedContent) {
      toast.error("内容不能为空");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const payload: Skill = {
        id: editing ? editing.id : "",
        name: trimmedName,
        description: description.trim() || null,
        directory: trimmedDirectory,
        content: trimmedContent,
        enabled: editing ? editing.enabled : false,
        created_at: editing ? editing.created_at : 0,
        updated_at: editing ? editing.updated_at : 0,
      };
      await api.upsertSkill(payload);
      toast.success(editing ? "Skill 已更新" : "Skill 已创建");
      closeDialog();
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const handleToggle = (v: SkillView) => {
    setError(null);
    api
      .toggleSkillEnabled(v.skill.id, !v.skill.enabled)
      .then(load)
      .catch(handleError);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteSkill(deleting.id);
      setDeleting(null);
      toast.success("Skill 已删除");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="page-stack" id="skills">
      <PageHeader
        title="Skills 管理"
        description="本地 skills 库，启用后写入 ~/.claude/skills/<目录>/SKILL.md（自动备份）"
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

      <div className="info-banner"><Sparkles className="h-4 w-4 shrink-0 text-primary" /><p>本地 Skills，按需启用。文件写入 ~/.claude/skills/&lt;目录&gt;/SKILL.md，已有内容自动备份。</p></div>
      <details className="rounded-2xl bg-card p-4"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">发现本地 Skills · {installed.length} 个（导入与 MCP 同步）</summary><Card className="mt-4 border-0 shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">已安装 Skills</CardTitle>
            <CardDescription>
              ~/.claude/skills 下实际存在的 skill，可导入管理列表或同步其声明的 MCP server
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
        </CardHeader>
        <CardContent>
          {installed.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              未在 ~/.claude/skills 下发现已安装 skill
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">名称</th>
                    <th className="px-4 py-3 font-medium">描述</th>
                    <th className="px-4 py-3 font-medium">版本</th>
                    <th className="px-4 py-3 font-medium">MCP</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {installed.map((s) => (
                    <tr
                      key={s.directory}
                      className="border-b border-border last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {s.name ?? s.directory}
                      </td>
                      <td title={s.description ?? undefined} className="max-w-[280px] truncate px-4 py-3 text-muted-foreground">
                        {s.description ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {s.version ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        {s.mcpServers.length > 0 ? (
                          <Badge variant="secondary" className="gap-1">
                            <Server className="h-3 w-3" />
                            {s.mcpServers.length}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          className={cn(
                            s.in_db
                              ? s.enabled
                                ? "border-transparent bg-success/10 text-success"
                                : "bg-secondary text-muted-foreground"
                              : "border-dashed bg-transparent text-muted-foreground"
                          )}
                        >
                          {s.in_db ? (s.enabled ? "已启用" : "已导入") : "未导入"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {!s.in_db && (
                            <button
                              className={`inline-flex items-center gap-1 text-primary hover:underline ${FOCUS_RING}`}
                              onClick={() => handleImport(s.directory)}
                            >
                              <Download className="h-3 w-3" />
                              导入
                            </button>
                          )}
                          {s.mcpServers.length > 0 && (
                            <button
                              className={`text-primary hover:underline ${FOCUS_RING}`}
                              onClick={() => handleSyncMcp(s.directory)}
                            >
                              同步 MCP
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card></details>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && !pending && closeDialog()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 Skill" : "新增 Skill"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "修改 Skill 内容后保存，启用状态保持"
                : "填写名称、目录与 SKILL.md 内容"}
            </DialogDescription>
          </DialogHeader>

<DialogBody className="space-y-5"><div className="space-y-4">
            <FormField label="名称" htmlFor="skill-name" error={formValidation.errors.name}>
<Input
                id="skill-name" onBlur={() => formValidation.touch("name")} aria-invalid={!!formValidation.errors.name}
                placeholder="例如：代码审查"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
</FormField>
            <div className="space-y-1.5">
              <Label htmlFor="skill-description">描述</Label>
              <Input
                id="skill-description"
                placeholder="简要说明该 Skill 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <FormField label="目录" htmlFor="skill-directory" error={formValidation.errors.directory}>
<Input
                id="skill-directory" onBlur={() => formValidation.touch("directory")} aria-invalid={!!formValidation.errors.directory}
                placeholder="仅允许字母、数字、_ 和 -"
                className="font-mono"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
              />
</FormField>
            <FormField label="内容" htmlFor="skill-content" error={formValidation.errors.content}>
<textarea
                id="skill-content" onBlur={() => formValidation.touch("content")} aria-invalid={!!formValidation.errors.content}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="在此输入 SKILL.md 内容..."
                className="min-h-[320px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
              />
</FormField>
          </div></DialogBody>

          <FormFooter onCancel={closeDialog} onSubmit={handleSave} busy={pending} submitDisabled={formValidation.invalid} />
        </DialogContent>
      </Dialog>

      {list.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="h-8 w-8" />}
          title="暂无 Skill"
          description="创建本地 Skill，启用后会写入 ~/.claude/skills/<目录>/SKILL.md"
        >
          <Button onClick={openCreate}>新增 Skill</Button>
        </EmptyState>
      ) : (
        <Card className="divide-y divide-border/60 overflow-hidden"><div className="page-toolbar p-6"><h2 className="text-base font-semibold">已安装 Skills</h2><span className="text-xs text-muted-foreground">{list.length} 个 Skill · {list.filter((v) => v.skill.enabled).length} 个已启用</span></div>{list.map((v) => <article key={v.skill.id} className="flex flex-wrap items-center gap-4 px-6 py-[22px]"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-background"><Sparkles className="h-5 w-5 text-muted-foreground" /></div><div className="min-w-0 flex-1 basis-[240px]"><h3 className="text-sm font-semibold">{v.skill.name}</h3><p className="mt-1.5 text-xs text-muted-foreground">{v.skill.description ?? "暂无描述"}</p><p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">~/.claude/skills/{v.skill.directory}/SKILL.md</p></div><Badge variant="secondary" className={v.synced ? "bg-success/10 text-success" : "text-muted-foreground"}>{v.synced ? "已同步" : "未同步"}</Badge><Switch checked={v.skill.enabled} onCheckedChange={() => setToggleTarget(v)} aria-label={`启用 ${v.skill.name}`} /><Button variant="ghost" size="sm" onClick={() => openEdit(v.skill)}>编辑</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(v.skill)}>删除</Button></article>)}</Card>
      )}

      <p className="text-xs text-muted-foreground">启用、更新与删除均会写入对应的本地目录；删除前需再次确认。</p>
      <ConfirmDialog open={!!toggleTarget} title={toggleTarget?.skill.enabled ? "停用 Skill？" : "启用 Skill？"} message={toggleTarget ? `将${toggleTarget.skill.enabled ? "移除同步的" : "写入"} ~/.claude/skills/${toggleTarget.skill.directory}/SKILL.md；已有文件按网关规则备份。` : undefined} onCancel={() => setToggleTarget(null)} onConfirm={() => { if (toggleTarget) handleToggle(toggleTarget); setToggleTarget(null); }} />
      <ConfirmDialog
        open={deleting !== null}
        title="删除 Skill"
        message={
          deleting
            ? `确定删除 Skill「${deleting.name}」吗？将同时删除 ~/.claude/skills/${deleting.directory}/SKILL.md。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
