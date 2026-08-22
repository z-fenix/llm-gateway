import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Channel, RolePattern, RoleRoute } from "../types";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

const ROLES = ["sonnet", "opus", "fable", "haiku"];
const PATTERN_ROLES = ["sonnet", "opus", "fable", "haiku", "auto"];
// "auto" 是未匹配任何角色时的兜底角色（走普通调度）。

const NONE = "__none__";

export default function RoleRoutesPage() {
  const [routes, setRoutes] = useState<RoleRoute[]>([]);
  const [patterns, setPatterns] = useState<RolePattern[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [fallback, setFallbackState] = useState<[string, string] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [patternOpen, setPatternOpen] = useState(false);
  const [editingPattern, setEditingPattern] = useState<RolePattern | null>(null);
  const [pPattern, setPPattern] = useState("");
  const [pRole, setPRole] = useState("sonnet");
  const [pPriority, setPPriority] = useState("0");
  const [pEnabled, setPEnabled] = useState(true);
  const [pending, setPending] = useState(false);

  const [deletingPattern, setDeletingPattern] = useState<RolePattern | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => {
    setError(null);
    api.listRoleRoutes().then(setRoutes).catch(handleError);
    api.listRolePatterns().then(setPatterns).catch(handleError);
    api.listChannels().then(setChannels).catch(handleError);
    api.getFallback().then(setFallbackState).catch(handleError);
  };
  useEffect(() => {
    load();
  }, []);

  const routeFor = (role: string) => routes.find((r) => r.role === role);

  const bind = async (role: string, channelId: string, targetModel: string) => {
    setError(null);
    try {
      if (!channelId) {
        await api.deleteRoleRoute(role);
      } else {
        await api.setRoleRoute(role, channelId, targetModel);
      }
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const bindFallbackChannel = (v: string) => {
    setError(null);
    if (v === NONE) {
      api
        .clearFallback()
        .then(() => {
          toast.success("已清除兜底");
          load();
        })
        .catch(handleError);
    } else {
      api
        .setFallback(v, fallback?.[1] ?? "")
        .then(load)
        .catch(handleError);
    }
  };

  const bindFallbackModel = (model: string) => {
    if (!fallback?.[0]) return;
    setError(null);
    api
      .setFallback(fallback[0], model)
      .then(load)
      .catch(handleError);
  };

  const clearFallback = () => {
    setError(null);
    api
      .clearFallback()
      .then(() => {
        toast.success("已清除兜底");
        load();
      })
      .catch(handleError);
  };

  const openCreatePattern = () => {
    setEditingPattern(null);
    setPPattern("");
    setPRole("sonnet");
    setPPriority("0");
    setPEnabled(true);
    setPatternOpen(true);
  };

  const openEditPattern = (p: RolePattern) => {
    setEditingPattern(p);
    setPPattern(p.pattern);
    setPRole(p.role);
    setPPriority(String(p.priority));
    setPEnabled(p.enabled);
    setPatternOpen(true);
  };

  const savePattern = async () => {
    const pattern = pPattern.trim();
    if (!pattern) {
      // 页面级 error 横幅位于 Dialog 遮罩之下，用户在弹窗内看不到；改用 toast 在弹窗上方提示
      toast.error("匹配模式不能为空");
      return;
    }
    const n = Number(pPriority);
    const priority = Number.isFinite(n) ? n : 0;
    setError(null);
    setPending(true);
    try {
      await api.upsertRolePattern({
        id: editingPattern?.id ?? "",
        pattern,
        role: pRole,
        priority,
        enabled: pEnabled,
      });
      setPatternOpen(false);
      setEditingPattern(null);
      toast.success(editingPattern ? "规则已更新" : "规则已创建");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const confirmDeletePattern = async () => {
    if (!deletingPattern) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteRolePattern(deletingPattern.id);
      setDeletingPattern(null);
      toast.success("规则已删除");
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
        title="角色路由"
        description="Claude Code 请求里的角色 → 固定走指定渠道的上游模型；失败走全局兜底"
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">角色 → 渠道路由</CardTitle>
          <CardDescription>按角色绑定上游渠道与模型，留空表示不路由</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="w-64 px-4 py-3 font-medium">渠道</th>
                  <th className="px-4 py-3 font-medium">上游模型</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((role) => {
                  const r = routeFor(role);
                  return (
                    <tr
                      key={role}
                      className="border-b border-border last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {role}
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          value={r?.channel_id || NONE}
                          onValueChange={(v) =>
                            bind(role, v === NONE ? "" : v, r?.target_model ?? "")
                          }
                        >
                          <SelectTrigger
                            className="h-8"
                            aria-label={`${role} 渠道`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>
                              （不路由 / 走普通调度）
                            </SelectItem>
                            {channels.map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-4 py-3">
                        <Input
                          className="h-8"
                          placeholder="上游模型，如 deepseek-v4-flash"
                          key={r?.target_model ?? ""}
                          defaultValue={r?.target_model ?? ""}
                          disabled={!r?.channel_id}
                          onBlur={(e) =>
                            r?.channel_id && bind(role, r.channel_id, e.target.value)
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg">全局兜底模型</CardTitle>
          <CardDescription>
            角色路由失败或未匹配角色时，所有请求最终可走此渠道
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[220px] space-y-1.5">
              <Label htmlFor="fallback-channel">渠道</Label>
              <Select
                value={fallback?.[0] || NONE}
                onValueChange={bindFallbackChannel}
              >
                <SelectTrigger
                  id="fallback-channel"
                  className="h-8"
                  aria-label="兜底渠道"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（无兜底）</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-[220px] space-y-1.5">
              <Label htmlFor="fallback-model">兜底上游模型</Label>
              <Input
                id="fallback-model"
                className="h-8"
                placeholder="兜底上游模型"
                key={fallback?.[1] ?? ""}
                defaultValue={fallback?.[1] ?? ""}
                disabled={!fallback?.[0]}
                onBlur={(e) => bindFallbackModel(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" onClick={clearFallback}>
              清除
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">角色识别规则</CardTitle>
            <CardDescription>
              通配符模式 → 角色映射；auto 表示未匹配时走普通调度
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreatePattern}>
            <Plus className="h-4 w-4" />
            新增规则
          </Button>
        </CardHeader>
        <CardContent>
          {patterns.length === 0 ? (
            <EmptyState
              title="暂无规则"
              description="还没有角色识别规则，添加规则让请求按角色路由"
            >
              <Button size="sm" onClick={openCreatePattern}>
                新增规则
              </Button>
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">模式</th>
                    <th className="px-4 py-3 font-medium">角色</th>
                    <th className="px-4 py-3 font-medium">优先级</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {patterns.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-4 py-3 font-mono text-foreground">
                        {p.pattern}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.role}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.priority}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={p.enabled ? "default" : "secondary"}>
                          {p.enabled ? "启用" : "禁用"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <button
                            className="text-primary hover:underline"
                            onClick={() => openEditPattern(p)}
                          >
                            编辑
                          </button>
                          <button
                            className="inline-flex items-center gap-1 text-destructive hover:underline"
                            onClick={() => setDeletingPattern(p)}
                          >
                            <Trash2 className="h-3 w-3" />
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

      <Dialog
        open={patternOpen}
        onOpenChange={(next) => {
          if (!next) {
            setPatternOpen(false);
            setEditingPattern(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingPattern ? "编辑规则" : "新增规则"}</DialogTitle>
            <DialogDescription>
              通配符模式（如 *sonnet*）匹配请求模型，映射到对应角色
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pattern-value">匹配模式</Label>
              <Input
                id="pattern-value"
                placeholder="*sonnet*"
                value={pPattern}
                onChange={(e) => setPPattern(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pattern-role">角色</Label>
              <Select value={pRole} onValueChange={setPRole}>
                <SelectTrigger id="pattern-role" aria-label="规则角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PATTERN_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                      {r === "auto" ? "（普通调度）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pattern-priority">优先级</Label>
              <Input
                id="pattern-priority"
                type="number"
                placeholder="0"
                value={pPriority}
                onChange={(e) => setPPriority(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="pattern-enabled">启用</Label>
              <Switch
                id="pattern-enabled"
                checked={pEnabled}
                onCheckedChange={setPEnabled}
              />
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setPatternOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={savePattern} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deletingPattern !== null}
        title="删除规则"
        message={
          deletingPattern
            ? `确定删除规则「${deletingPattern.pattern}」吗？`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeletingPattern(null)}
        onConfirm={confirmDeletePattern}
      />
    </div>
  );
}
