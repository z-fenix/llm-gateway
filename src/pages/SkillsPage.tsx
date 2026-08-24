import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, RefreshCw, Server, Sparkles } from "lucide-react";
import { api } from "../lib/api";
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

  const [deleting, setDeleting] = useState<Skill | null>(null);

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
    <div>
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

      <Card className="mb-6">
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
              <table className="w-full text-sm">
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
                      <td className="max-w-[280px] truncate px-4 py-3 text-muted-foreground">
                        {s.description ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {s.version ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        {s.mcp_servers.length > 0 ? (
                          <Badge variant="secondary" className="gap-1">
                            <Server className="h-3 w-3" />
                            {s.mcp_servers.length}
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
                                ? "border-transparent bg-emerald-500/10 text-emerald-600"
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
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={() => handleImport(s.directory)}
                            >
                              <Download className="h-3 w-3" />
                              导入
                            </button>
                          )}
                          {s.mcp_servers.length > 0 && (
                            <button
                              className="text-primary hover:underline"
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
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 Skill" : "新增 Skill"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "修改 Skill 内容后保存，启用状态保持"
                : "填写名称、目录与 SKILL.md 内容"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">名称</Label>
              <Input
                id="skill-name"
                placeholder="例如：代码审查"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-description">描述</Label>
              <Input
                id="skill-description"
                placeholder="简要说明该 Skill 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-directory">目录</Label>
              <Input
                id="skill-directory"
                placeholder="仅允许字母、数字、_ 和 -"
                className="font-mono"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-content">内容</Label>
              <textarea
                id="skill-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="在此输入 SKILL.md 内容..."
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
          icon={<Sparkles className="h-8 w-8" />}
          title="暂无 Skill"
          description="创建本地 Skill，启用后会写入 ~/.claude/skills/<目录>/SKILL.md"
        >
          <Button onClick={openCreate}>新增 Skill</Button>
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">描述</th>
                <th className="px-4 py-3 font-medium">目录</th>
                <th className="px-4 py-3 font-medium">同步</th>
                <th className="px-4 py-3 font-medium">启用</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr
                  key={v.skill.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {v.skill.name}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {v.skill.description ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {v.skill.directory}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      className={cn(
                        v.synced
                          ? "border-transparent bg-emerald-500/10 text-emerald-600"
                          : "bg-secondary text-muted-foreground"
                      )}
                    >
                      {v.synced ? "已同步" : "未同步"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={v.skill.enabled}
                      onCheckedChange={() => handleToggle(v)}
                      aria-label={`启用 ${v.skill.name}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => openEdit(v.skill)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-destructive hover:underline"
                        onClick={() => setDeleting(v.skill)}
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
