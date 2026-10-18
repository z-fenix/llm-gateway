import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, Plus, RefreshCw, Server, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { FOCUS_RING } from "../lib/focusRing";
import type { InstalledSkill, Skill, SkillView } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { StatusBadge } from "../components/StatusBadge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
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

/** Skills 对话框行内校验（前端与后端同一套规则：名称/目录/内容必填，后端为准）。 */
type SkillField = "name" | "description" | "directory" | "content";
type SkillFieldErrors = Partial<Record<"name" | "directory" | "content", string>>;

function validateSkillForm(
  name: string,
  directory: string,
  content: string,
): SkillFieldErrors {
  const errs: SkillFieldErrors = {};
  if (!name.trim()) errs.name = "名称不能为空";
  if (!directory.trim()) errs.directory = "目录不能为空";
  if (!content.trim()) errs.content = "内容不能为空";
  return errs;
}

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
  // DSH touched 语义：pristine 空表单不喊错——行内错误仅「字段被触碰（blur/onChange）且无效」
  // 或「曾尝试提交」时渲染；应用按钮仍按原始校验态禁用（不受 touched 影响）。
  const [touched, setTouched] = useState<Partial<Record<SkillField, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const errors = validateSkillForm(name, directory, content);
  const formValid = Object.keys(errors).length === 0;
  const touch = (k: SkillField) =>
    setTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const showErr = (k: "name" | "directory" | "content") =>
    touched[k] || submitAttempted ? errors[k] : undefined;

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
    setTouched({});
    setSubmitAttempted(false);
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
      const payload: Skill = {
        id: editing ? editing.id : "",
        name: name.trim(),
        description: description.trim() || null,
        directory: directory.trim(),
        content: content.trim(),
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
                        <StatusBadge
                          semantic={
                            s.in_db ? (s.enabled ? "success" : "neutral") : "neutral"
                          }
                          className={!s.in_db ? "border border-dashed" : undefined}
                        >
                          {s.in_db ? (s.enabled ? "已启用" : "已导入") : "未导入"}
                        </StatusBadge>
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
            <FormField label="名称" htmlFor="skill-name" required error={showErr("name")}>
              <Input
                id="skill-name"
                placeholder="例如：代码审查"
                value={name}
                onBlur={() => touch("name")}
                onChange={(e) => {
                  touch("name");
                  setName(e.target.value);
                }}
              />
            </FormField>
            <FormField label="描述" htmlFor="skill-description">
              <Input
                id="skill-description"
                placeholder="简要说明该 Skill 的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <FormField label="目录" htmlFor="skill-directory" required error={showErr("directory")}>
              <Input
                id="skill-directory"
                placeholder="仅允许字母、数字、_ 和 -"
                className="font-mono"
                value={directory}
                onBlur={() => touch("directory")}
                onChange={(e) => {
                  touch("directory");
                  setDirectory(e.target.value);
                }}
              />
            </FormField>
            <FormField label="内容" htmlFor="skill-content" required error={showErr("content")}>
              <textarea
                id="skill-content"
                value={content}
                onBlur={() => touch("content")}
                onChange={(e) => {
                  touch("content");
                  setContent(e.target.value);
                }}
                placeholder="在此输入 SKILL.md 内容..."
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
                    <StatusBadge semantic={v.synced ? "success" : "neutral"}>
                      {v.synced ? "已同步" : "未同步"}
                    </StatusBadge>
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
                        className={`text-primary hover:underline ${FOCUS_RING}`}
                        onClick={() => openEdit(v.skill)}
                      >
                        编辑
                      </button>
                      <button
                        className={`text-destructive hover:underline ${FOCUS_RING}`}
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
