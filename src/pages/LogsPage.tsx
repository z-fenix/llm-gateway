import { Fragment, useEffect, useMemo, useState } from "react";
import { Layers, List, Search } from "lucide-react";
import { api } from "../lib/api";
import { bucketSizeForRange, fillBuckets, localOffsetSecs } from "../lib/trend";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import type { ApiKey, Channel, LogFilter, LogStats, RequestLog, SecurityFinding, TimeBucket, UsageRangeSelection } from "../types";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
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
    case "info": return "bg-blue-100 text-blue-700";
    case "low": return "bg-green-100 text-green-700";
    case "medium": return "bg-yellow-100 text-yellow-700";
    case "high": return "bg-orange-100 text-orange-700";
    case "critical": return "bg-red-100 text-red-700";
    default: return "bg-muted text-muted-foreground";
  }
}

function actionMarker(action: string, sanitized: boolean): React.ReactNode {
  const a = action.toLowerCase();
  if (a === "block") {
    return (<span className="ml-1 text-xs text-red-600">已阻断</span>);
  }
  if (a === "redact" || a === "sanitize" || sanitized) {
    return (<span className="ml-1 text-xs text-blue-600">已脱敏</span>);
  }
  return null;
}

function FindingsPanel({ logId }: { logId: string }) {
  const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
  useEffect(() => {
    api.getSecurityFindings(logId).then(setFindings).catch(console.error);
  }, [logId]);

  if (findings === null) return <div className="text-xs text-muted-foreground">加载 findings...</div>;
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

const ROLES = ["sonnet", "opus", "fable", "haiku", "auto"];
const RISK_LEVELS = ["clean", "info", "low", "medium", "high", "critical"];
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
];

const LOG_COLUMNS = [
  "#", "时间", "密钥", "角色", "请求模型", "上游模型", "渠道", "状态", "风险", "Token", "延迟", "兜底",
];

const selectCls =
  "h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20";

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

function LogRow({
  log,
  open,
  onToggle,
}: {
  log: RequestLog;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <tr
        className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-muted-foreground">{log.seq}</td>
        <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
          {new Date(log.created_at * 1000).toLocaleString()}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{log.key_name ?? "-"}</td>
        <td className="px-4 py-3">
          {log.role ? (
            <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100">
              {log.role}
            </Badge>
          ) : (
            "-"
          )}
        </td>
        <td className="px-4 py-3 font-mono text-xs text-foreground">
          {log.request_model ?? "-"}
        </td>
        <td className="px-4 py-3 font-mono text-xs text-foreground">
          {log.upstream_model ?? "-"}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{log.channel_name ?? "-"}</td>
        <td
          className={cn(
            "px-4 py-3",
            log.status_code === 200 ? "text-green-600" : "text-red-600"
          )}
        >
          {log.status_code ?? "-"}
        </td>
        <td className="px-4 py-3">
          <span className={cn("rounded px-1 text-xs", riskBadgeClass(log.risk_level))}>
            {log.risk_level}
          </span>
          {actionMarker(log.security_action, log.sanitized)}
        </td>
        <td className="px-4 py-3 text-muted-foreground">
          {log.input_tokens}+{log.output_tokens}
        </td>
        <td className="px-4 py-3 text-muted-foreground">{log.latency_ms}ms</td>
        <td className="px-4 py-3 text-muted-foreground">
          {log.fallback ? "是" : "-"}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/50">
          <td colSpan={12} className="px-4 py-3">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-mono">TraceID: {log.trace_id}</span>
                {log.error && <span className="text-destructive">{log.error}</span>}
                {log.risk_summary && <span className="text-orange-600">{log.risk_summary}</span>}
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-card p-2 text-xs">
                  {prettyJson(log.request_body)}
                </pre>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-card p-2 text-xs">
                  {log.response_body ? prettyJson(log.response_body) : "(无响应体 / 流式)"}
                </pre>
              </div>
              {log.risk_level !== "clean" && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    风险详情
                  </div>
                  <FindingsPanel logId={log.id} />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

type SessionGroup = { trace_id: string; logs: RequestLog[] };

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

  // 按 trace_id 对当前页结果分组：一个 trace 即一次会话
  const sessions = useMemo<SessionGroup[]>(() => {
    const map = new Map<string, RequestLog[]>();
    for (const log of data.items) {
      const key = log.trace_id;
      const arr = map.get(key);
      if (arr) arr.push(log);
      else map.set(key, [log]);
    }
    return Array.from(map.entries()).map(([trace_id, logs]) => ({ trace_id, logs }));
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
    <div>
      <PageHeader
        title="请求日志"
        description="查看网关请求记录、安全风险与调用趋势，可按会话分组浏览"
        action={
          <RefreshControls
            secs={secs}
            onSecsChange={setSecs}
            onRefresh={() => setRefreshNonce((n) => n + 1)}
          />
        }
      />
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">筛选</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-56"
              placeholder="搜索 模型/渠道/TraceID/密钥"
              value={filter.keyword || ""}
              onChange={(e) => updateFilter({ keyword: e.target.value || undefined })}
            />
            <select
              className={selectCls}
              value={filter.channel_id || ""}
              onChange={(e) => updateFilter({ channel_id: e.target.value || undefined })}
            >
              <option value="">全部渠道</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select
              className={selectCls}
              value={filter.api_key_id || ""}
              onChange={(e) => updateFilter({ api_key_id: e.target.value || undefined })}
            >
              <option value="">全部密钥</option>
              {apiKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
            <select
              className={selectCls}
              value={filter.role || ""}
              onChange={(e) => updateFilter({ role: e.target.value || undefined })}
            >
              <option value="">全部角色</option>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select
              className={selectCls}
              value={filter.risk_level || ""}
              onChange={(e) => updateFilter({ risk_level: e.target.value || undefined })}
            >
              <option value="">全部风险</option>
              {RISK_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <select
              className={selectCls}
              value={filter.status || ""}
              onChange={(e) => updateFilter({ status: e.target.value as LogFilter["status"] || undefined })}
            >
              {STATUS_OPTIONS.map((s) => <option key={s.label} value={s.value || ""}>{s.label}</option>)}
            </select>
            <select
              className={selectCls}
              value={filter.is_stream === undefined ? "" : String(filter.is_stream)}
              onChange={(e) => {
                const v = e.target.value;
                updateFilter({ is_stream: v === "" ? undefined : v === "true" });
              }}
            >
              {STREAM_OPTIONS.map((s) => <option key={s.label} value={s.value === undefined ? "" : String(s.value)}>{s.label}</option>)}
            </select>
            <UsageDateRangePicker
              selection={rangeSel}
              onApply={onRangeApply}
              triggerLabel={rangeLabel}
            />
            <Button onClick={() => onSearch()}>
              <Search className="h-4 w-4" />
              查询
            </Button>
          </div>
        </CardContent>
      </Card>

      {stats && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-4">
            <div className="text-sm text-muted-foreground">总调用</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{stats.total_calls}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-muted-foreground">总 Token</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{totalTokens.toLocaleString()}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-muted-foreground">成功率</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{successRate !== null ? `${successRate}%` : "—"}</div>
          </Card>
          <Card className="p-4">
            <div className="text-sm text-muted-foreground">风险分布</div>
            <div className="mt-2 flex flex-wrap gap-1">
              {stats.risk_distribution.length === 0 && <span className="text-xs text-muted-foreground">无</span>}
              {stats.risk_distribution.map(([level, count]) => (
                <span key={level} className={cn("rounded px-1 text-xs", riskBadgeClass(level))}>{level}: {count}</span>
              ))}
            </div>
          </Card>
        </div>
      )}

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

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">日志清理</CardTitle>
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
              className="text-orange-600"
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

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">日志列表</CardTitle>
          <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
            <button
              onClick={() => setView("flat")}
              className={cn(
                "flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                view === "flat"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <List className="h-3.5 w-3.5" />
              平铺列表
            </button>
            <button
              onClick={() => setView("session")}
              className={cn(
                "flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                view === "session"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              按会话分组
            </button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {data.items.length === 0 ? (
            <EmptyState
              title="暂无日志"
              description="当前筛选条件下没有请求日志，调整筛选条件后点击「查询」"
            />
          ) : view === "flat" ? (
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
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
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">TraceID</th>
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
                    const expanded = openSession === s.trace_id;
                    return (
                      <Fragment key={s.trace_id}>
                        <tr
                          className={cn(
                            "cursor-pointer border-b border-border last:border-0 hover:bg-accent/50",
                            expanded && "bg-accent/30"
                          )}
                          onClick={() => setOpenSession(expanded ? null : s.trace_id)}
                        >
                          <td
                            className="px-4 py-3 font-mono text-xs text-foreground"
                            title={s.trace_id}
                          >
                            {shortTrace(s.trace_id)}
                          </td>
                          <td className="px-4 py-3 text-foreground">{s.logs.length}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {new Date(first.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {new Date(last.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {roles.length ? roles.join(" / ") : "-"}
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
                              <div className="overflow-x-auto overflow-hidden rounded-lg border border-border bg-card">
                                <table className="w-full text-sm">
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

          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
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
    </div>
  );
}
