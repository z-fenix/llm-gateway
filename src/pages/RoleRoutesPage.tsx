import { DialogBody } from "../components/ui/dialog";
import { FOCUS_RING } from "../lib/focusRing";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Edit3, Plus, Trash2 } from "lucide-react";
import { ModelCombobox } from "../components/ModelCombobox";
import { api } from "../lib/api";
import { useFormValidation } from "../lib/useFormValidation";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
import { roleName, roleLabel } from "../lib/roles";
import { formatTokenAmount } from "../lib/tokenUnits";
import { aggregateBreaker, BreakerIndicator } from "../components/BreakerIndicator";
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
  sonnet: "bg-primary",
  opus: "bg-primary",
  fable: "bg-warning",
  haiku: "bg-success",
  image: "bg-destructive",
  auto: "bg-muted",
};

function intOr(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
  const [rulesOpen, setRulesOpen] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
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
  const routeValidation = useFormValidation({ channel: rChannelId ? undefined : "请选择渠道", model: rModel.trim() ? undefined : "上游模型不能为空" });
  const patternValidation = useFormValidation({ pattern: pPattern.trim() ? undefined : "匹配模式不能为空" });

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
    routeValidation.reset();
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
    routeValidation.reset();
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
    if (pending || routeValidation.invalid) return;
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
    patternValidation.reset();
    setEditingPattern(null);
    setPPattern("");
    setPRole("sonnet");
    setPPriority("0");
    setPEnabled(true);
    setPatternOpen(true);
  };

  const openEditPattern = (p: RolePattern) => {
    patternValidation.reset();
    setEditingPattern(p);
    setPPattern(p.pattern);
    setPRole(p.role);
    setPPriority(String(p.priority));
    setPEnabled(p.enabled);
    setPatternOpen(true);
  };

  const savePattern = async () => {
    if (pending || patternValidation.invalid) return;
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
    <div className="page-stack" id="role-routes">
      <PageHeader
        title={selectedRole ? `${roleLabel(selectedRole)} 路由` : "角色路由"}
        description="为模型角色配置首选渠道、多路由调度与回退策略。"
        action={selectedRole ? <Button onClick={() => openCreateRoute(selectedRole)}><Plus />新增路由</Button> : <Button onClick={() => setRulesOpen(true)}><Plus />管理识别规则</Button>}
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {selectedRole === null ? (
        <>
          <div className="page-toolbar text-xs text-muted-foreground"><span className="text-[13px]">6 个角色 · {ROLE_ORDER.filter((role) => routes.some((r) => r.role === role && r.enabled)).length} 个已配置</span><span>选择角色，管理多个优先级与权重路由</span></div>
          <div className="table-shell">
            <table className="data-table min-w-[880px]">
              <thead><tr><th>角色 / 匹配</th><th>首选渠道</th><th>目标模型</th><th>路由数</th><th>熔断状态</th><th>操作</th></tr></thead>
              <tbody>{ROLE_ORDER.map((role) => {
                const roleRoutes = routesByRole(routes, role);
                const preferred = roleRoutes.find((route) => route.enabled);
                const breakerState = aggregateBreaker(roleRoutes, breakerStatus);
                return <tr key={role}>
                  <td><p className="font-semibold"><span>{roleName(role)}</span><span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">{role}</span></p><p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{patterns.filter((p) => p.role === role).map((p) => p.pattern).join(" / ") || (role === "auto" ? "未命中角色" : "尚未配置匹配规则")}</p></td>
                  <td>{channels.find((c) => c.id === preferred?.channel_id)?.name ?? "尚未配置"}</td>
                  <td className="max-w-[260px] break-all font-mono text-xs">{preferred?.target_model ?? "—"}</td>
                  <td>{roleRoutes.length} 条</td>
                  <td><BreakerIndicator state={breakerState} /></td>
                  <td><Button variant="outline" size="sm" aria-label={`查看 ${role} 角色详情`} onClick={() => setSelectedRole(role)}>配置</Button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">全局回退</CardTitle>
              <Button variant="outline" size="sm" onClick={() => setFallbackOpen(!fallbackOpen)}>{fallbackOpen ? "完成" : "编辑回退"}</Button>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-[13px] text-muted-foreground">角色路由失败后，尝试以下备用渠道与模型。</p>
              {!fallbackOpen ? <div className="flex flex-wrap items-center gap-3 rounded-xl bg-background p-4 text-[13px]"><span className="font-medium">角色路由</span><span className="text-muted-foreground">→ 失败时回退 →</span><span className="font-medium">{channels.find((c) => c.id === fallback?.[0])?.name ?? "尚未配置"}</span>{fallback?.[1] && <span className="font-mono text-xs">/ {fallback[1]}</span>}</div> :
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
              </div>}
            </CardContent>
          </Card>

          <Dialog open={rulesOpen} onOpenChange={setRulesOpen}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>角色识别规则</DialogTitle><DialogDescription>通配符模式映射到模型角色，按优先级匹配。</DialogDescription></DialogHeader>

<DialogBody className="space-y-5"><Card className="border-0 shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">匹配规则与路由</CardTitle>
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
                    创建第一条规则
                  </Button>
                </EmptyState>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border/60">
                  <table className="data-table w-full text-sm">
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
                            {roleLabel(p.role)}
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
                                className={`text-primary hover:underline ${FOCUS_RING}`}
                                onClick={() => openEditPattern(p)}
                              >
                                编辑
                              </button>
                              <button
                                className={`inline-flex items-center gap-1 text-destructive hover:underline ${FOCUS_RING}`}
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
          </Card></DialogBody>

          </DialogContent></Dialog>
        </>
      ) : (
        /* 角色详情面板 */
        <>
          <div className="page-toolbar"><Button variant="outline" size="sm" onClick={() => setSelectedRole(null)}><ArrowLeft />返回角色概览</Button><p className="font-mono text-xs text-muted-foreground">匹配模式 {patterns.filter((p) => p.role === selectedRole).map((p) => p.pattern).join(" / ") || "未命中角色模式"}</p></div>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {[ ["请求数", roleStats[selectedRole]?.requests ?? 0], ["Token", formatTokenAmount(roleStats[selectedRole]?.tokens ?? 0)], ["成功率", successRate(roleStats[selectedRole])], ["平均延迟", `${roleStats[selectedRole]?.avg_latency_ms ?? 0}ms`] ].map(([label, value]) => <div key={label} className="rounded-2xl bg-card p-5"><dt className="text-xs text-muted-foreground">{label}</dt><dd title={label === "Token" ? (roleStats[selectedRole]?.tokens ?? 0).toLocaleString() : undefined} className="mt-3 text-[28px] font-semibold">{value}</dd></div>)}
            </dl>
            {detailRoutes.length === 0 ? (
              <EmptyState
                title={`暂无「${roleLabel(selectedRole)}」路由`}
                description="添加路由让角色请求固定走指定供应商，失败自动切换/熔断"
              >
                <Button size="sm" onClick={() => openCreateRoute(selectedRole)}>
                  新增路由
                </Button>
              </EmptyState>
            ) : (
              <div className="space-y-6">
                <Card className="space-y-4 p-6"><h3 className="text-base font-semibold">优先尝试高优先级路由</h3>
                {detailRoutes.map((r, index) => {
                  const breaker = breakerStatus[r.id];
                  return <article key={r.id} className="rounded-xl bg-background p-5">
                    <div className="page-toolbar"><div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-semibold">{channels.find((c) => c.id === r.channel_id)?.name ?? "渠道已移除"}</h3>{index === 0 && <Badge variant="secondary">首选路由</Badge>}<BreakerIndicator state={breaker?.state} /></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" aria-label="编辑路由" onClick={() => openEditRoute(r)}>编辑</Button><Button variant="ghost" size="icon" aria-label="删除路由" className="text-destructive" onClick={() => setDeletingRoute(r)}><Trash2 /></Button><Switch checked={r.enabled} onCheckedChange={(enabled) => saveRoute(r, { enabled })} aria-label={`${r.role} 路由启用`} /></div></div>
                    <p className="mt-3 break-all font-mono text-xs">{r.target_model}</p>
                    <p className="mt-3 text-xs text-muted-foreground">优先级 {r.priority} · 权重 {r.weight} · 连续失败 {breaker?.failures ?? 0} 次</p>
                  </article>;
                })}
                </Card><Card className="space-y-4 p-6"><h3 className="text-base font-semibold">熔断策略</h3><div className="grid gap-4 sm:grid-cols-2">{detailRoutes.map((r) => <div key={r.id} className="rounded-xl bg-background p-4"><p className="mb-3 text-xs font-medium">{channels.find((c) => c.id === r.channel_id)?.name ?? r.channel_id}</p><div className="flex flex-wrap gap-4"><label className="space-y-2 text-xs text-muted-foreground">连续失败阈值<Input aria-label={`${r.id} 熔断阈值`} type="number" min={1} key={r.breaker_max_failures} defaultValue={r.breaker_max_failures} className="w-24" onBlur={(e) => { const value = intOr(e.target.value, r.breaker_max_failures); if (value !== r.breaker_max_failures) void saveRoute(r, { breaker_max_failures: value }); }} /></label><label className="space-y-2 text-xs text-muted-foreground">冷却时间（秒）<Input aria-label={`${r.id} 冷却时间`} type="number" min={1} key={r.breaker_cooldown_secs} defaultValue={r.breaker_cooldown_secs} className="w-24" onBlur={(e) => { const value = intOr(e.target.value, r.breaker_cooldown_secs); if (value !== r.breaker_cooldown_secs) void saveRoute(r, { breaker_cooldown_secs: value }); }} /></label></div></div>)}</div><p className="text-xs leading-relaxed text-muted-foreground">达到阈值后暂时跳过此路由；冷却结束进入半开状态。路由失败后仍可继续尝试全局回退。</p></Card>
              </div>
            )}
        </>
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

<DialogBody className="space-y-5"><div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="route-role">角色</Label>
              <Select value={rRole} onValueChange={setRRole}>
                <SelectTrigger id="route-role" aria-label="路由角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PATTERN_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-channel">渠道</Label>
              <Select value={rChannelId} onValueChange={handleRouteChannelChange}>
                <SelectTrigger id="route-channel" aria-label="路由渠道" onBlur={() => routeValidation.touch("channel")} aria-invalid={!!routeValidation.errors.channel}>
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
            {routeValidation.errors.channel && <p role="alert" className="text-xs text-destructive">{routeValidation.errors.channel}</p>}
            <FormField label="上游模型" htmlFor="route-model" error={routeValidation.errors.model}><ModelCombobox id="route-model" ariaLabel="上游模型" value={rModel} onChange={setRModel} options={rChannelModels} onBlur={() => routeValidation.touch("model")} error={!!routeValidation.errors.model} /></FormField>
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
          </div></DialogBody>

          <FormFooter onCancel={() => setRouteOpen(false)} onSubmit={createRoute} busy={pending} submitDisabled={routeValidation.invalid} />
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

<DialogBody className="space-y-5"><div className="space-y-4">
            <FormField label="匹配模式" htmlFor="pattern-value" error={patternValidation.errors.pattern}>
<Input
                id="pattern-value" onBlur={() => patternValidation.touch("pattern")} aria-invalid={!!patternValidation.errors.pattern}
                placeholder="*sonnet*"
                value={pPattern}
                onChange={(e) => setPPattern(e.target.value)}
              />
</FormField>
            <div className="space-y-1.5">
              <Label htmlFor="pattern-role">角色</Label>
              <Select value={pRole} onValueChange={setPRole}>
                <SelectTrigger id="pattern-role" aria-label="规则角色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PATTERN_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleLabel(r)}
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
          </div></DialogBody>

          <FormFooter onCancel={() => setPatternOpen(false)} onSubmit={savePattern} busy={pending} submitDisabled={patternValidation.invalid} />
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
            ? `确定删除角色「${roleLabel(deletingRoute.role)}」的这条路由吗？`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeletingRoute(null)}
        onConfirm={confirmDeleteRoute}
      />
    </div>
  );
}
