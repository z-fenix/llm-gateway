import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Edit3, Plus, Trash2 } from "lucide-react";
import { ModelCombobox } from "../components/ModelCombobox";
import { api } from "../lib/api";
import { ROLE_ORDER, routesByRole } from "../lib/roleSort";
import type {
  BreakerStatus,
  Channel,
  RolePattern,
  RoleRoute,
  RoleStats,
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

// 角色模式可选角色与角色卡顺序共用同一份列表，避免两处维护漂移
const PATTERN_ROLES = ROLE_ORDER;
// "auto" 是未匹配任何角色模式时的占位角色：可绑定渠道/模型；未绑定则走普通调度。

const NONE = "__none__";

// 角色卡色标（字面类名，Tailwind 内容扫描可见）
const ROLE_COLORS: Record<string, string> = {
  sonnet: "bg-sky-500",
  opus: "bg-violet-500",
  fable: "bg-amber-500",
  haiku: "bg-emerald-500",
  image: "bg-rose-500",
  auto: "bg-slate-400",
};

const BREAKER_LABEL: Record<string, string> = {
  closed: "正常",
  open: "已熔断",
  half_open: "半开",
};

function breakerBadgeVariant(state?: string): "default" | "destructive" | "secondary" {
  switch (state) {
    case "open":
      return "destructive";
    case "half_open":
      return "secondary";
    default:
      return "default";
  }
}

function intOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function successRate(stat?: RoleStats): string {
  if (!stat || stat.requests <= 0) return "-";
  return `${Math.round((stat.success_count / stat.requests) * 100)}%`;
}

export default function RoleRoutesPage() {
  const [routes, setRoutes] = useState<RoleRoute[]>([]);
  const [patterns, setPatterns] = useState<RolePattern[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [fallback, setFallbackState] = useState<[string, string] | null>(null);
  const [breakerStatus, setBreakerStatus] = useState<Record<string, BreakerStatus>>({});
  const [roleStats, setRoleStats] = useState<Record<string, RoleStats>>({});
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [routeOpen, setRouteOpen] = useState(false);
  const [rRole, setRRole] = useState("sonnet");
  const [rChannelId, setRChannelId] = useState("");
  const [rModel, setRModel] = useState("");
  const [rPriority, setRPriority] = useState("0");
  const [rWeight, setRWeight] = useState("1");
  const [rMaxFailures, setRMaxFailures] = useState("5");
  const [rCooldown, setRCooldown] = useState("60");
  const [rChannelModels, setRChannelModels] = useState<string[]>([]);

  const [patternOpen, setPatternOpen] = useState(false);
  const [editingPattern, setEditingPattern] = useState<RolePattern | null>(null);
  const [pPattern, setPPattern] = useState("");
  const [pRole, setPRole] = useState("sonnet");
  const [pPriority, setPPriority] = useState("0");
  const [pEnabled, setPEnabled] = useState(true);
  const [pending, setPending] = useState(false);

  const [deletingPattern, setDeletingPattern] = useState<RolePattern | null>(null);
  const [deletingRoute, setDeletingRoute] = useState<RoleRoute | null>(null);
  const [editingRoute, setEditingRoute] = useState<RoleRoute | null>(null);

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
    api
      .getBreakerStatus()
      .then((list) =>
        setBreakerStatus(Object.fromEntries(list.map((b) => [b.route_id, b]))),
      )
      .catch(handleError);
    api
      .getRoleStats()
      .then((list) =>
        setRoleStats(Object.fromEntries(list.map((s) => [s.role, s]))),
      )
      .catch(handleError);
  };
  useEffect(() => {
    load();
  }, []);

  const saveRoute = async (route: RoleRoute, patch: Partial<RoleRoute>) => {
    setError(null);
    try {
      await api.upsertRoleRoute({ ...route, ...patch });
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const openCreateRoute = (role: string) => {
    setEditingRoute(null);
    setRRole(role);
    setRChannelId("");
    setRModel("");
    setRPriority("0");
    setRWeight("1");
    setRMaxFailures("5");
    setRCooldown("60");
    setRChannelModels([]);
    setRouteOpen(true);
  };

  const openEditRoute = (r: RoleRoute) => {
    setEditingRoute(r);
    setRRole(r.role);
    setRChannelId(r.channel_id);
    setRModel(r.target_model);
    setRPriority(String(r.priority));
    setRWeight(String(r.weight));
    setRMaxFailures(String(r.breaker_max_failures));
    setRCooldown(String(r.breaker_cooldown_secs));
    setRChannelModels(r.channel_id ? channels.find((c) => c.id === r.channel_id)?.models ?? [] : []);
    setRouteOpen(true);
  };

  const createRoute = async () => {
    if (!rChannelId) {
      toast.error("请选择渠道");
      return;
    }
    if (!rModel.trim()) {
      toast.error("上游模型不能为空");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await api.upsertRoleRoute({
        ...(editingRoute ?? {
          id: "",
          role: rRole,
          channel_id: rChannelId,
          target_model: rModel.trim(),
          priority: intOr(rPriority, 0),
          weight: intOr(rWeight, 1),
          breaker_max_failures: intOr(rMaxFailures, 5),
          breaker_cooldown_secs: intOr(rCooldown, 60),
          enabled: true,
          updated_at: 0,
        }),
        role: rRole,
        channel_id: rChannelId,
        target_model: rModel.trim(),
        priority: intOr(rPriority, 0),
        weight: intOr(rWeight, 1),
        breaker_max_failures: intOr(rMaxFailures, 5),
        breaker_cooldown_secs: intOr(rCooldown, 60),
      });
      setRouteOpen(false);
      setEditingRoute(null);
      toast.success(editingRoute ? "路由已更新" : "角色路由已创建");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const handleRouteChannelChange = (id: string) => {
    setRChannelId(id);
    setRModel("");
    const ch = channels.find((c) => c.id === id);
    setRChannelModels(ch ? ch.models : []);
  };

  const confirmDeleteRoute = async () => {
    if (!deletingRoute) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteRoleRoute(deletingRoute.id);
      setDeletingRoute(null);
      toast.success("路由已删除");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
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

  // 角色详情面板的路由（选中角色时非空），只计算一次供空态判断与列表共用
  const detailRoutes = selectedRole ? routesByRole(routes, selectedRole) : [];

  return (
    <div>
      <PageHeader
        title="角色路由"
        description="同一角色可配置多个供应商/模型，按优先级+权重自动路由，失败自动切换并支持熔断"
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {selectedRole === null ? (
        <>
          {/* 角色汇总卡总览 */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {ROLE_ORDER.map((role) => {
              const roleRoutes = routes.filter((r) => r.role === role);
              const stat = roleStats[role];
              const hasOpenBreaker = roleRoutes.some(
                (r) => breakerStatus[r.id]?.state === "open",
              );
              return (
                <Card
                  key={role}
                  role="button"
                  tabIndex={0}
                  aria-label={`查看 ${role} 角色详情`}
                  className="cursor-pointer transition-shadow hover:shadow-md"
                  onClick={() => setSelectedRole(role)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedRole(role);
                    }
                  }}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-3 w-3 shrink-0 rounded-full ${
                            ROLE_COLORS[role] ?? "bg-slate-400"
                          }`}
                        />
                        <CardTitle className="text-base">{role}</CardTitle>
                      </div>
                      <Badge variant="secondary">配置 {roleRoutes.length} 条</Badge>
                    </div>
                    <CardDescription>
                      {role === "auto"
                        ? "未匹配角色模式的占位路由"
                        : `${role} 角色路由与上游统计`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasOpenBreaker && (
                      <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
                        存在已熔断路由
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                      <div>
                        <div className="text-xs text-muted-foreground">请求数</div>
                        <div className="font-medium">{stat?.requests ?? 0}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Token</div>
                        <div className="font-medium">
                          {formatTokens(stat?.tokens ?? 0)}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">成功率</div>
                        <div className="font-medium">{successRate(stat)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">平均延迟</div>
                        <div className="font-medium">
                          {stat ? `${stat.avg_latency_ms}ms` : "-"}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

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
                  通配符模式 → 角色映射；auto 是未匹配占位角色，可绑定渠道/模型
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
        </>
      ) : (
        /* 角色详情面板 */
        <Card className="mb-6">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedRole(null)}
              >
                <ArrowLeft className="h-4 w-4" />
                返回
              </Button>
              <div>
                <CardTitle className="text-lg">{selectedRole} 路由</CardTitle>
                <CardDescription>
                  {selectedRole === "auto"
                    ? "未匹配角色模式的占位路由；请求按优先级降序、同优先级按权重随机选取，熔断中的路由自动跳过"
                    : `「${selectedRole}」角色可配置多条路由；按优先级降序、同优先级按权重随机选取，熔断中的路由自动跳过`}
                </CardDescription>
              </div>
            </div>
            <Button size="sm" onClick={() => openCreateRoute(selectedRole)}>
              <Plus className="h-4 w-4" />
              新增路由
            </Button>
          </CardHeader>
          <CardContent>
            {detailRoutes.length === 0 ? (
              <EmptyState
                title={`暂无「${selectedRole}」路由`}
                description="添加路由让角色请求固定走指定供应商，失败自动切换/熔断"
              >
                <Button size="sm" onClick={() => openCreateRoute(selectedRole)}>
                  新增路由
                </Button>
              </EmptyState>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="w-44 px-4 py-3 font-medium">渠道</th>
                      <th className="px-4 py-3 font-medium">上游模型</th>
                      <th className="w-20 px-4 py-3 font-medium">优先级</th>
                      <th className="w-20 px-4 py-3 font-medium">权重</th>
                      <th className="px-4 py-3 font-medium">熔断（失败/冷却s）</th>
                      <th className="px-4 py-3 font-medium">状态</th>
                      <th className="w-14 px-4 py-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailRoutes.map((r) => {
                      const breaker = breakerStatus[r.id];
                      return (
                        <tr
                          key={r.id}
                          className="border-b border-border last:border-0 hover:bg-accent/50"
                        >
                          <td className="px-4 py-3">
                            <Select
                              value={r.channel_id}
                              onValueChange={(v) => saveRoute(r, { channel_id: v })}
                            >
                              <SelectTrigger className="h-8" aria-label={`${r.role} 渠道`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
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
                              key={r.target_model}
                              defaultValue={r.target_model}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v && v !== r.target_model) {
                                  saveRoute(r, { target_model: v });
                                }
                              }}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <Input
                              className="h-8 w-16"
                              type="number"
                              key={r.priority}
                              defaultValue={r.priority}
                              onBlur={(e) => {
                                const v = intOr(e.target.value, r.priority);
                                if (v !== r.priority) saveRoute(r, { priority: v });
                              }}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <Input
                              className="h-8 w-16"
                              type="number"
                              key={r.weight}
                              defaultValue={r.weight}
                              onBlur={(e) => {
                                const v = intOr(e.target.value, r.weight);
                                if (v !== r.weight) saveRoute(r, { weight: v });
                              }}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <Input
                                className="h-8 w-16"
                                type="number"
                                key={r.breaker_max_failures}
                                defaultValue={r.breaker_max_failures}
                                onBlur={(e) => {
                                  const v = intOr(
                                    e.target.value,
                                    r.breaker_max_failures,
                                  );
                                  if (v !== r.breaker_max_failures)
                                    saveRoute(r, { breaker_max_failures: v });
                                }}
                              />
                              <span className="text-muted-foreground">/</span>
                              <Input
                                className="h-8 w-16"
                                type="number"
                                key={r.breaker_cooldown_secs}
                                defaultValue={r.breaker_cooldown_secs}
                                onBlur={(e) => {
                                  const v = intOr(
                                    e.target.value,
                                    r.breaker_cooldown_secs,
                                  );
                                  if (v !== r.breaker_cooldown_secs)
                                    saveRoute(r, { breaker_cooldown_secs: v });
                                }}
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Badge variant={breakerBadgeVariant(breaker?.state)}>
                                {BREAKER_LABEL[breaker?.state ?? "closed"]}
                              </Badge>
                              {breaker && breaker.failures > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  连续失败 {breaker.failures}
                                </span>
                              )}
                              <Switch
                                checked={r.enabled}
                                onCheckedChange={(v) => saveRoute(r, { enabled: v })}
                                aria-label={`${r.role} 路由启用`}
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <button
                                className="text-primary hover:underline"
                                aria-label="编辑路由"
                                title="编辑"
                                onClick={() => openEditRoute(r)}
                              >
                                <Edit3 className="h-3 w-3" />
                              </button>
                              <button
                                className="inline-flex items-center gap-1 text-destructive hover:underline"
                                aria-label="删除路由"
                                onClick={() => setDeletingRoute(r)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={routeOpen}
        onOpenChange={(next) => {
          if (!next) setRouteOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingRoute ? "编辑角色路由" : "新增角色路由"}</DialogTitle>
            <DialogDescription>
              同一角色可配置多个供应商，请求自动路由，失败切换并熔断
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="route-role">角色</Label>
              <Select value={rRole} onValueChange={setRRole}>
                <SelectTrigger id="route-role" aria-label="路由角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PATTERN_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                      {role === "auto" ? "（未匹配占位）" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-channel">渠道</Label>
              <Select value={rChannelId} onValueChange={handleRouteChannelChange}>
                <SelectTrigger id="route-channel" aria-label="路由渠道">
                  <SelectValue placeholder="选择渠道" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-model">上游模型</Label>
              <Select value={rModel} onValueChange={setRModel}>
                <SelectTrigger id="route-model" aria-label="上游模型">
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {rChannelModels.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="route-priority">优先级</Label>
                <Input
                  id="route-priority"
                  type="number"
                  value={rPriority}
                  onChange={(e) => setRPriority(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="route-weight">权重</Label>
                <Input
                  id="route-weight"
                  type="number"
                  value={rWeight}
                  onChange={(e) => setRWeight(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="route-max-failures">熔断阈值（连续失败）</Label>
                <Input
                  id="route-max-failures"
                  type="number"
                  value={rMaxFailures}
                  onChange={(e) => setRMaxFailures(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="route-cooldown">冷却时间（秒）</Label>
                <Input
                  id="route-cooldown"
                  type="number"
                  value={rCooldown}
                  onChange={(e) => setRCooldown(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setRouteOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={createRoute} disabled={pending}>
              {pending ? "保存中..." : editingRoute ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                      {r === "auto" ? "（未匹配占位）" : ""}
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

      <ConfirmDialog
        open={deletingRoute !== null}
        title="删除路由"
        message={
          deletingRoute
            ? `确定删除角色「${deletingRoute.role}」的这条路由吗？`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeletingRoute(null)}
        onConfirm={confirmDeleteRoute}
      />
    </div>
  );
}
