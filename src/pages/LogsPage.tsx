import { DialogBody } from "../components/ui/dialog";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Copy, Layers, List, Search, ShieldCheck } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../components/ui/dialog";
import FilterSelect from "../components/FilterSelect";
import { roleLabel } from "../lib/roles";
import { formatTokenAmount } from "../lib/tokenUnits";
import SegmentedControl from "../components/SegmentedControl";
import { api } from "../lib/api";
import { GATEWAY_REFRESH_EVENT } from "../lib/events";
import { httpStatusSemantic } from "../lib/semantics";
import { StatusBadge } from "../components/StatusBadge";
import { bucketSizeForRange, fillBuckets, localOffsetSecs } from "../lib/trend";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import type { ApiKey, Channel, LogFilter, LogStats, RequestLog, SecurityFinding, TimeBucket, UsageRangeSelection } from "../types";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import { UsageDateRangePicker } from "../components/UsageDateRangePicker";
import { cacheHitRatePercent, formatUsd } from "../lib/usage";

function prettyJson(s?: string | null): string {
  if (!s) return "(无内容)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function riskBadgeClass(level: string): string {
  switch (level) {
    case "clean": return "bg-muted text-muted-foreground";
    case "info": return "bg-primary/10 text-primary";
    case "low": return "bg-success/10 text-success";
    case "medium": return "bg-warning/10 text-warning";
    case "high": return "bg-warning/10 text-warning";
    case "critical": return "bg-destructive/10 text-destructive";
    default: return "bg-muted text-muted-foreground";
  }
}

function actionMarker(action: string, sanitized: boolean): React.ReactNode {
  const a = action.toLowerCase();
  if (a === "block") {
    return (<span className="ml-1 text-xs text-destructive">已阻断</span>);
  }
  if (a === "redact" || a === "sanitize" || sanitized) {
    return (<span className="ml-1 text-xs text-primary">已脱敏</span>);
  }
  return null;
}

function shortSessionId(id?: string | null): string {
  if (!id) return "";
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function sessionProviderLabel(p?: string | null): string {
  switch (p) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "gemini": return "Gemini";
    default: return p ?? "";
  }
}

function sessionBadgeClass(p?: string | null): string {
  switch (p) {
    case "claude": return "bg-primary/10 text-primary";
    case "codex": return "bg-primary/10 text-primary";
    case "gemini": return "bg-primary/10 text-primary";
    default: return "bg-muted text-muted-foreground";
  }
}

function FindingsPanel({ logId }: { logId: string }) {
  const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setFindings(null);
    api.getSecurityFindings(logId)
      .then((value) => { if (!cancelled) setFindings(value); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [logId, attempt]);

  if (error) return <ErrorBanner message={error} onRetry={() => setAttempt((n) => n + 1)} />;
  if (findings === null) return <div role="status" className="text-xs text-muted-foreground">正在加载安全发现...</div>;
  if (findings.length === 0) return <div className="text-xs text-muted-foreground">无风险详情</div>;

  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li key={f.id} className="rounded-md border border-border bg-card p-2 text-xs">
          <div className="flex flex-wrap gap-2 font-medium">
            <span className={cn("rounded px-1", riskBadgeClass(f.severity))}>{f.severity}</span>
            <span>{f.title}</span>
            <span className="text-muted-foreground">({f.phase})</span>
          </div>
          {f.description && (
            <div className="mt-1 text-muted-foreground">{f.description}</div>
          )}
          {f.evidence_masked && (
            <div className="mt-1 font-mono text-muted-foreground">
              {f.evidence_masked}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function dateToEndOfDaySeconds(dateStr: string): number {
  if (!dateStr) return 0;
  return Math.floor(new Date(`${dateStr}T23:59:59`).getTime() / 1000);
}

// 初始 7d 窗口:默认聚焦近一周,选择器可随时扩大/自定义
function initialFilter(): LogFilter {
  const r = resolveUsageRange({ preset: "7d" });
  return { after: r.startDate, before: r.endDate };
}

const ROLES = ["sonnet", "opus", "fable", "haiku", "image", "auto"];
const RISK_LEVELS = ["clean", "info", "low", "medium", "high", "critical"];
const SESSION_PROVIDERS = [
  { label: "全部", value: "" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Gemini", value: "gemini" },
];
const STATUS_OPTIONS: { label: string; value: LogFilter["status"] }[] = [
  { label: "全部状态", value: undefined },
  { label: "2xx", value: "2xx" },
  { label: "4xx", value: "4xx" },
  { label: "5xx", value: "5xx" },
];
const STREAM_OPTIONS: { label: string; value: boolean | undefined }[] = [
  { label: "全部", value: undefined },
  { label: "流式", value: true },
  { label: "非流式", value: false },
];
const DIMENSION_TABS: { label: string; value: Dimension }[] = [
  { label: "调用量", value: "calls" },
  { label: "Token", value: "tokens" },
  { label: "成功率", value: "success" },
  { label: "风险分布", value: "risk" },
  { label: "缓存", value: "cache" },
  { label: "成本", value: "cost" },
];

const LOG_COLUMNS = ["时间 / Trace", "模型 / 角色", "渠道", "结果", "Token", "延迟", "安全", "详情"];

function LogTableHeader() {
  return (
    <thead>
      <tr className="border-b border-border text-left text-muted-foreground">
        {LOG_COLUMNS.map((c) => (
          <th key={c} className="whitespace-nowrap px-4 py-3 font-medium">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function LogRow({ log, open, onToggle }: { log: RequestLog; open: boolean; onToggle: () => void }) {
  const [detailTab, setDetailTab] = useState("request");
  return <Fragment>
    <tr className="cursor-pointer" onClick={onToggle}>
      <td className="whitespace-nowrap"><p className="text-xs">{new Date(log.created_at * 1000).toLocaleString()}</p><p className="mt-1.5 font-mono text-[11px] text-muted-foreground" title={log.trace_id}>{shortTrace(log.trace_id)}</p></td>
      <td><p className="max-w-[220px] truncate font-mono text-xs" title={log.request_model ?? undefined}>{log.request_model ?? "-"}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{roleLabel(log.role ?? "auto")}{log.fallback ? " · 已回退" : ""}{log.session_id ? ` · ${sessionProviderLabel(log.session_provider)} ${shortSessionId(log.session_id)}` : ""}</p></td>
      <td className="text-xs">{log.channel_name ?? "-"}</td>
      <td><StatusBadge semantic={httpStatusSemantic(log.status_code ?? 0)}>{log.status_code ?? "—"}</StatusBadge></td>
      <td title={`输入 ${log.input_tokens.toLocaleString()} / 输出 ${log.output_tokens.toLocaleString()}`} className="whitespace-nowrap text-xs tabular-nums">{formatTokenAmount(log.input_tokens)} + {formatTokenAmount(log.output_tokens)}</td>
      <td className="whitespace-nowrap text-xs tabular-nums">{log.latency_ms}ms</td>
      <td><span className={cn("rounded-full px-2 py-1 text-[11px]", riskBadgeClass(log.risk_level))}>{log.risk_level}</span>{actionMarker(log.security_action, log.sanitized)}</td>
      <td><Button variant="ghost" size="sm" aria-label={`查看请求 ${log.seq} 详情`}>详情</Button></td>
    </tr>
    <Dialog open={open} onOpenChange={(next) => { if (!next && open) onToggle(); }}>
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-none w-full max-w-[620px] translate-x-0 translate-y-0 content-start rounded-none border-0 p-7 sm:max-w-[620px]">
        <DialogHeader><DialogTitle className="text-2xl">请求详情</DialogTitle><DialogDescription className="break-all pr-6">TraceID: {log.trace_id}</DialogDescription></DialogHeader>

<DialogBody className="space-y-5"><div className="flex items-center justify-between gap-3 rounded-xl bg-background p-4"><StatusBadge semantic={httpStatusSemantic(log.status_code ?? 0)}>{log.status_code ?? "未知状态"} · {log.is_stream ? "流式响应" : "非流式响应"}</StatusBadge><Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(log.trace_id); toast.success("已复制 Trace ID"); } catch { toast.error("复制失败，请手动复制 Trace ID"); } }}><Copy />复制 ID</Button></div>
        <dl className="space-y-4 text-xs">{[["请求时间", new Date(log.created_at * 1000).toLocaleString()], ["客户端协议", log.protocol], ["调用密钥", log.key_name ?? "-"], ["请求模型", log.request_model ?? "-"], ["角色 / 上游", `${roleLabel(log.role ?? "auto")} → ${log.channel_name ?? "-"}`], ["上游模型", log.upstream_model ?? "-"]].map(([label, value]) => <div key={label} className="flex justify-between gap-6"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-all text-right font-medium">{value}</dd></div>)}</dl>
        <dl title={`Token: ${(log.input_tokens + log.output_tokens).toLocaleString()}`} aria-label="本次用量" className="grid grid-cols-3 gap-3">{[["Token", formatTokenAmount(log.input_tokens + log.output_tokens)], ["总延迟", `${log.latency_ms} ms`], ["估算费用", formatUsd(log.total_cost_usd ?? 0)]].map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl bg-background p-4"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="mt-2 break-all text-lg font-semibold tabular-nums">{value}</dd></div>)}</dl>
        {log.error && <p role="alert" className="rounded-xl bg-destructive/5 p-4 text-sm text-destructive">{log.error}</p>}
        <SegmentedControl value={detailTab} onChange={setDetailTab} label="请求详情内容" options={[{ value: "request", label: "请求内容" }, { value: "response", label: "响应内容" }, { value: "security", label: "安全发现" }]} />
        <div className="info-banner"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" /><p className="text-xs leading-6">日志内容已经过凭据过滤。{log.sanitized ? "本次请求已执行安全脱敏。" : "请勿将业务日志公开分享。"}{log.risk_summary}</p></div>
        {detailTab === "security" ? <FindingsPanel logId={log.id} /> : <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-background p-5 font-mono text-xs leading-6">{detailTab === "request" ? prettyJson(log.request_body) : log.response_body ? prettyJson(log.response_body) : "(无响应体 / 流式)"}</pre>}
        <details className="rounded-xl bg-background p-4 text-xs"><summary className="cursor-pointer font-medium">更多请求信息</summary><dl className="mt-4 space-y-3">{[["本地会话", log.session_id ?? "-"], ["输入 Token", log.input_tokens], ["输出 Token", log.output_tokens], ["缓存读取", log.cache_read_tokens ?? 0], ["缓存创建", log.cache_creation_tokens ?? 0], ["兜底", log.fallback ? "是" : "否"]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd title={typeof value === "number" ? value.toLocaleString() : undefined} className="min-w-0 break-all text-right">{typeof value === "number" ? formatTokenAmount(value) : value}</dd></div>)}</dl></details>
        {log.tool_calls && <details className="rounded-xl bg-background p-4 text-xs"><summary className="cursor-pointer font-medium">工具调用</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-all">{prettyJson(log.tool_calls)}</pre></details>}</DialogBody>

      </DialogContent>
    </Dialog>
  </Fragment>;
}

type SessionGroup = { key: string; logs: RequestLog[] };

function shortTrace(trace: string): string {
  return trace.length > 16 ? `${trace.slice(0, 16)}…` : trace;
}

function worstRisk(logs: RequestLog[]): string {
  let worst = "clean";
  for (const l of logs) {
    if (RISK_LEVELS.indexOf(l.risk_level) > RISK_LEVELS.indexOf(worst)) {
      worst = l.risk_level;
    }
  }
  return worst;
}

export default function LogsPage() {
  const [filter, setFilter] = useState<LogFilter>(initialFilter);
  const [page, setPage] = useState(0);
  const [searchNonce, setSearchNonce] = useState(0);
  const [data, setData] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [view, setView] = useState<"flat" | "session">("flat");
  const [moreFilters, setMoreFilters] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [secs, setSecs] = useRefreshInterval("logs-refresh");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [dimension, setDimension] = useState<Dimension>("calls");
  const [rangeSel, setRangeSel] = useState<UsageRangeSelection>({ preset: "7d" });
  const rangeLabel = getUsageRangePresetLabel(rangeSel.preset);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [retentionDays, setRetentionDays] = useState<number>(30);
  const [retentionInput, setRetentionInput] = useState<string>("30");
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [cleanupDate, setCleanupDate] = useState<string>("");
  const limit = 20;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const bucketFor = (f: LogFilter) =>
    bucketSizeForRange(f.after ?? 0, f.before ?? 0);

  const bucketSize = useMemo(() => bucketFor(filter), [filter.after, filter.before]);

  const loadList = () => {
    api.listLogs({ ...filter, limit, offset: page * limit })
      .then((res) => { setData(res); setError(null); })
      .catch(handleError);
  };

  const loadStatsTrend = (f: LogFilter = filter) => {
    const bs = bucketFor(f);
    const off = localOffsetSecs();
    Promise.all([
      api.getLogStats(f),
      api.getLogTimeseries(f, bs, off),
    ]).then(([statsData, bucketsData]) => {
      setStats(statsData);
      setBuckets(fillBuckets(bucketsData, f.after ?? 0, f.before ?? 0, bs, off));
      setError(null);
    }).catch(handleError);
  };

  // page effect 负责列表请求：初始挂载、分页、查询、刷新都会触发
  useEffect(() => { loadList(); }, [page, searchNonce, refreshNonce]);

  // 挂载时加载元数据（渠道/密钥/保留天数），不随刷新重复请求
  useEffect(() => {
    api.listChannels().then(setChannels).catch(handleError);
    api.listApiKeys().then(setApiKeys).catch(handleError);
    api.getLogRetentionDays().then((days) => {
      setRetentionDays(days);
      setRetentionInput(String(days));
    }).catch(handleError);
  }, []);

  // 从 URL 参数解析 session 筛选（支持从会话页跳转）
  useEffect(() => {
    const sid = searchParams.get("session_id");
    const sp = searchParams.get("session_provider");
    if (sid || sp) {
      setFilter((prev) => ({
        ...prev,
        session_id: sid || undefined,
        session_provider: sp || undefined,
      }));
      setPage(0);
      setSearchNonce((n) => n + 1);
      setSearchParams(new URLSearchParams(), { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 统计与趋势随刷新非ce变化重新加载
  useEffect(() => {
    loadStatsTrend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  // 自动刷新
  useEffect(() => {
    if (!secs) return;
    const t = setInterval(() => setRefreshNonce((n) => n + 1), secs * 1000);
    return () => clearInterval(t);
  }, [secs]);

  const updateFilter = (patch: Partial<LogFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch }));
  };

  const onSearch = (f?: LogFilter) => {
    setPage(0);
    setSearchNonce((n) => n + 1);
    loadStatsTrend(f);
  };

  const onRangeApply = (sel: UsageRangeSelection) => {
    setRangeSel(sel);
    const r = resolveUsageRange(sel);
    const next = { ...filter, after: r.startDate, before: r.endDate };
    updateFilter({ after: r.startDate, before: r.endDate });
    onSearch(next);
  };

  const successRate = useMemo(() => {
    if (!stats || stats.total_calls === 0) return null;
    return ((stats.success_count / stats.total_calls) * 100).toFixed(1);
  }, [stats]);

  const totalTokens = useMemo(() => {
    if (!stats) return 0;
    return stats.total_input_tokens + stats.total_output_tokens;
  }, [stats]);

  // 缓存命中率 = cache_read / (input + cache_creation + cache_read)，0 兜底（LogStats 无直接命中率字段）
  const cacheHitRate = useMemo(() => {
    if (!stats) return 0;
    return cacheHitRatePercent(
      stats.total_input_tokens,
      stats.cache_read_tokens ?? 0,
      stats.cache_creation_tokens ?? 0
    );
  }, [stats]);

  // 按 session_id 对当前页结果分组；无 session_id 时回退到 trace_id
  const sessions = useMemo<SessionGroup[]>(() => {
    const map = new Map<string, RequestLog[]>();
    for (const log of data.items) {
      const key = log.session_id || log.trace_id;
      const arr = map.get(key);
      if (arr) arr.push(log);
      else map.set(key, [log]);
    }
    return Array.from(map.entries()).map(([key, logs]) => ({ key, logs }));
  }, [data.items]);

  const onDeleteBefore = () => {
    if (!cleanupDate) return;
    const before = dateToEndOfDaySeconds(cleanupDate);
    if (!before) return;
    const msg = `确定删除 ${cleanupDate} 之前的全部日志？此操作不可恢复，并将级联删除关联的安全发现。`;
    if (!window.confirm(msg)) return;
    api.deleteLogsBefore(before).then(() => {
      setCleanupDate("");
      loadList();
      loadStatsTrend();
    }).catch(handleError);
  };

  const onClearAll = () => {
    const msg1 = "确定清空全部日志？此操作不可恢复，并将级联删除关联的安全发现。";
    const msg2 = "再次确认：将永久删除所有日志记录及关联发现，无法撤销。";
    if (!window.confirm(msg1)) return;
    if (!window.confirm(msg2)) return;
    api.clearLogs().then(() => {
      loadList();
      loadStatsTrend();
    }).catch(handleError);
  };

  const onSaveRetention = () => {
    setRetentionError(null);
    const days = Number(retentionInput);
    if (!Number.isFinite(days) || days < 0 || !Number.isInteger(days)) {
      setRetentionError("必须为非负整数");
      return;
    }
    api.setLogRetentionDays(days).then(() => {
      setRetentionDays(days);
      setRetentionError(null);
    }).catch(handleError);
  };

  return (
    <div className="page-stack" id="request-logs">
      <PageHeader
        title="请求日志"
        description="查看网关请求记录、安全风险与调用趋势，可按会话分组浏览"
        navigationAction={<div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" onClick={() => setMaintenanceOpen(true)}>日志保留与清理</Button><Button variant="outline" size="sm" onClick={() => setView(view === "flat" ? "session" : "flat")}>{view === "flat" ? <List /> : <Layers />}{view === "flat" ? "按会话分组" : "平铺列表"}</Button><Button variant="outline" size="sm" onClick={() => setTrendOpen(true)}>趋势与分布</Button></div>}
        action={
          <RefreshControls
            secs={secs}
            onSecsChange={setSecs}
            onRefresh={() => { setRefreshNonce((n) => n + 1); window.dispatchEvent(new Event(GATEWAY_REFRESH_EVENT)); }}
          />
        }
      />
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5" aria-label="日志筛选">
        <UsageDateRangePicker selection={rangeSel} onApply={onRangeApply} triggerLabel={rangeLabel} />
        <div className="relative w-full sm:w-[310px]"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" aria-label="搜索日志" placeholder="模型、渠道、Trace ID 或密钥" value={filter.keyword || ""} onChange={(e) => updateFilter({ keyword: e.target.value || undefined })} onKeyDown={(e) => e.key === "Enter" && onSearch()} /></div>
        <FilterSelect label="渠道筛选" value={filter.channel_id || ""} onChange={value => updateFilter({ channel_id: value || undefined })} options={[{ value: "", label: "全部渠道" }, ...channels.map(c => ({ value: c.id, label: c.name }))]} />
        <FilterSelect label="状态筛选" value={filter.status || ""} onChange={value => updateFilter({ status: value as LogFilter["status"] || undefined })} options={STATUS_OPTIONS.map(v => ({ value: v.value || "", label: v.label }))} />
        <Button variant="outline" size="sm" aria-expanded={moreFilters} aria-controls="advanced-log-filters" onClick={() => setMoreFilters(!moreFilters)}>更多筛选</Button>
        <Button size="sm" onClick={() => onSearch()}><Search />查询</Button>
      </div>
      {moreFilters && <div id="advanced-log-filters" className="flex flex-wrap gap-3 rounded-xl bg-card p-4">
        <FilterSelect label="密钥筛选" value={filter.api_key_id || ""} onChange={value => updateFilter({ api_key_id: value || undefined })} options={[{ value: "", label: "全部密钥" }, ...apiKeys.map(k => ({ value: k.id, label: k.name }))]} />
        <FilterSelect label="角色筛选" value={filter.role || ""} onChange={value => updateFilter({ role: value || undefined })} options={[{ value: "", label: "全部角色" }, ...ROLES.map(r => ({ value: r, label: roleLabel(r) }))]} />
        <FilterSelect label="风险筛选" value={filter.risk_level || ""} onChange={value => updateFilter({ risk_level: value || undefined })} options={[{ value: "", label: "全部风险" }, ...RISK_LEVELS.map(r => ({ value: r, label: r }))]} />
        <FilterSelect label="流式筛选" value={filter.is_stream === undefined ? "" : String(filter.is_stream)} onChange={value => updateFilter({ is_stream: value === "" ? undefined : value === "true" })} options={STREAM_OPTIONS.map(v => ({ value: v.value === undefined ? "" : String(v.value), label: v.label }))} />
        <FilterSelect label="会话来源" value={filter.session_provider || ""} onChange={value => updateFilter({ session_provider: value || undefined })} options={SESSION_PROVIDERS} />
        <Input className="w-full sm:w-48" aria-label="会话 ID" placeholder="Session ID" value={filter.session_id || ""} onChange={(e) => updateFilter({ session_id: e.target.value || undefined })} />
        {stats && <p className="w-full text-xs text-muted-foreground">风险分布：{stats.risk_distribution.map(([level, count]) => `${level} ${count}`).join(" · ") || "无"}</p>}
      </div>}
      {stats && <dl aria-label="范围内统计" className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
        {[["调用量", stats.total_calls.toLocaleString()], ["成功率", successRate !== null ? `${successRate}%` : "—"], ["真实 Token", formatTokenAmount(totalTokens)], ["缓存命中率", `${cacheHitRate.toFixed(1)}%`], ["估算费用", formatUsd(stats.cost ?? 0)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd title={label === "真实 Token" ? totalTokens.toLocaleString() : undefined} className="mt-2 text-[28px] font-semibold tracking-tight tabular-nums">{value}</dd></div>)}
      </dl>}

      <Card>
        <CardContent className="p-0">
          {data.items.length === 0 ? (
            <EmptyState
              title="暂无日志"
              description="当前筛选条件下没有请求日志，调整筛选条件后点击「查询」"
            />
          ) : view === "flat" ? (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <LogTableHeader />
                <tbody>
                  {data.items.map((l) => (
                    <LogRow
                      key={l.id}
                      log={l}
                      open={open === l.id}
                      onToggle={() => setOpen(open === l.id ? null : l.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">会话</th>
                    <th className="px-4 py-3 font-medium">请求数</th>
                    <th className="px-4 py-3 font-medium">首次时间</th>
                    <th className="px-4 py-3 font-medium">最后时间</th>
                    <th className="px-4 py-3 font-medium">角色</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">风险</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const sorted = [...s.logs].sort((a, b) => a.created_at - b.created_at);
                    const first = sorted[0];
                    const last = sorted[sorted.length - 1];
                    const roles = Array.from(
                      new Set(s.logs.map((l) => l.role).filter((r): r is string => !!r))
                    );
                    const statuses = Array.from(
                      new Set(
                        s.logs
                          .map((l) => l.status_code)
                          .filter((c): c is number => c !== null)
                      )
                    );
                    const worst = worstRisk(s.logs);
                    const expanded = openSession === s.key;
                    const isSessionGroup = s.logs.some((l) => l.session_id === s.key);
                    return (
                      <Fragment key={s.key}>
                        <tr
                          className={cn(
                            "cursor-pointer border-b border-border last:border-0 hover:bg-accent/50",
                            expanded && "bg-accent/30"
                          )}
                          onClick={() => setOpenSession(expanded ? null : s.key)}
                        >
                          <td
                            className="px-4 py-3 font-mono text-xs text-foreground"
                            title={s.key}
                          >
                            <div className="flex items-center gap-2">
                              {isSessionGroup && s.logs[0]?.session_provider && (
                                <span className={cn("w-fit rounded px-1 text-xs", sessionBadgeClass(s.logs[0].session_provider))}>
                                  {sessionProviderLabel(s.logs[0].session_provider)}
                                </span>
                              )}
                              <span>{isSessionGroup ? shortSessionId(s.key) : shortTrace(s.key)}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-foreground">{s.logs.length}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {new Date(first.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {new Date(last.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {roles.length ? roles.map(roleLabel).join(" / ") : "-"}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {statuses.length ? statuses.join(" / ") : "-"}
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn("rounded px-1 text-xs", riskBadgeClass(worst))}>
                              {worst}
                            </span>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="border-b border-border bg-muted/30">
                            <td colSpan={7} className="px-4 py-3">
                              <div className="overflow-x-auto bg-card">
                                <table className="data-table w-full text-sm">
                                  <LogTableHeader />
                                  <tbody>
                                    {s.logs.map((l) => (
                                      <LogRow
                                        key={l.id}
                                        log={l}
                                        open={open === l.id}
                                        onToggle={() => setOpen(open === l.id ? null : l.id)}
                                      />
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 p-4 text-xs text-muted-foreground">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>
              第 {page + 1} 页 / 共 {Math.max(1, Math.ceil(data.total / limit))} 页（{data.total} 条）
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * limit >= data.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </CardContent>
      </Card>
      <Dialog open={trendOpen} onOpenChange={setTrendOpen}><DialogContent className="sm:max-w-4xl"><DialogHeader><DialogTitle>趋势与分布</DialogTitle><DialogDescription>当前筛选范围内的调用趋势与排行。</DialogDescription></DialogHeader>
<DialogBody className="space-y-5"><div>
      {stats && (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="p-4">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Top 渠道</div>
            {stats.top_channels.length === 0 ? <div className="text-xs text-muted-foreground">无数据</div> : (
              <ul className="space-y-0.5">
                {stats.top_channels.map(([name, count]) => (
                  <li key={name} className="flex justify-between text-xs"><span>{name}</span><span>{count}</span></li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Top 密钥</div>
            {stats.top_api_keys.length === 0 ? <div className="text-xs text-muted-foreground">无数据</div> : (
              <ul className="space-y-0.5">
                {stats.top_api_keys.map(([name, count]) => (
                  <li key={name} className="flex justify-between text-xs"><span>{name}</span><span>{count}</span></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">趋势</CardTitle>
          <div className="flex gap-1 text-sm" role="tablist" aria-label="趋势维度">
            {DIMENSION_TABS.map((tab) => (
              <button
                key={tab.value}
                role="tab"
                aria-selected={dimension === tab.value}
                onClick={() => setDimension(tab.value)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors",
                  dimension === tab.value
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <LogTrendChart buckets={buckets} dimension={dimension} bucketSecs={bucketSize} />
        </CardContent>
      </Card>

      </div></DialogBody>
</DialogContent></Dialog>
      <Dialog open={maintenanceOpen} onOpenChange={setMaintenanceOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>日志清理</DialogTitle><DialogDescription>设置保留天数，或在二次确认后清理已有记录。</DialogDescription></DialogHeader>
<DialogBody className="space-y-5"><div>
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">保留策略</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="cleanup-date" className="text-sm text-muted-foreground">
              清理日期
            </Label>
            <Input
              id="cleanup-date"
              type="date"
              className="w-40"
              value={cleanupDate}
              onChange={(e) => setCleanupDate(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="text-warning"
              onClick={onDeleteBefore}
            >
              删除该日之前
            </Button>
            <Button variant="destructive" size="sm" onClick={onClearAll}>
              清空全部
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Label htmlFor="retention-days" className="text-sm text-muted-foreground">
                日志保留天数
              </Label>
              <Input
                id="retention-days"
                type="number"
                min={0}
                className="w-20"
                value={retentionInput}
                onChange={(e) => setRetentionInput(e.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={onSaveRetention}>
                保存
              </Button>
              {retentionError && (
                <span className="text-xs text-destructive">{retentionError}</span>
              )}
              <span className="text-xs text-muted-foreground">当前: {retentionDays} 天</span>
            </div>
          </div>
        </CardContent>
      </Card>

      </div></DialogBody>
</DialogContent></Dialog>
      <p className="text-xs leading-relaxed text-muted-foreground">更多筛选：角色、API 密钥、风险级别、流式模式、会话来源。点击请求查看脱敏后的请求与响应。</p>
    </div>
  );
}
