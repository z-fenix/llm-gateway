import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Layers, List, Search } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { bucketSizeForRange, fillBuckets, localOffsetSecs } from "../lib/trend";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import type { ApiKey, Channel, LogFilter, LogStats, RequestLog, SecurityFinding, TimeBucket, UsageRangeSelection } from "../types";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { StatusBadge } from "../components/StatusBadge";
import { httpStatusSemantic, riskSemantic } from "../lib/semantics";
import { SegmentedTabs } from "../components/SegmentedTabs";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import { UsageDateRangePicker } from "../components/UsageDateRangePicker";
import { formatUsd } from "../lib/usage";

function prettyJson(s?: string | null): string {
  if (!s) return "(无内容)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function actionMarker(action: string, sanitized: boolean): React.ReactNode {
  const a = action.toLowerCase();
  if (a === "block") {
    return (<span className="ml-1 text-xs text-destructive">已阻断</span>);
  }
  if (a === "redact" || a === "sanitize" || sanitized) {
    return (<span className="ml-1 text-xs text-info">已脱敏</span>);
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
            <StatusBadge semantic={riskSemantic(f.severity)}>{f.severity}</StatusBadge>
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

// 全部选项的哨兵值（Radix Select 不允许空字符串 item value）
const ALL = "all";

const NUMERIC_CELL = "px-3 py-2 text-right font-mono tabular-nums text-muted-foreground";

const LOG_COLUMNS: { label: string; align?: "right" }[] = [
  { label: "#" }, { label: "时间" }, { label: "密钥" }, { label: "角色" }, { label: "本地会话" },
  { label: "请求模型" }, { label: "上游模型" }, { label: "渠道" }, { label: "状态" }, { label: "风险" },
  { label: "Token", align: "right" }, { label: "缓存读取", align: "right" }, { label: "缓存创建", align: "right" },
  { label: "费用", align: "right" }, { label: "延迟", align: "right" }, { label: "兜底" },
];

function LogTableHeader() {
  return (
    <thead>
      <tr className="border-b border-border text-left text-muted-foreground">
        {LOG_COLUMNS.map((c) => (
          <th
            key={c.label}
            className={cn(
              "whitespace-nowrap px-3 py-2 font-medium",
              c.align === "right" && "text-right"
            )}
          >
            {c.label}
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
        <td className="px-3 py-2 text-muted-foreground">{log.seq}</td>
        <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">
          {new Date(log.created_at * 1000).toLocaleString()}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{log.key_name ?? "-"}</td>
        <td className="px-3 py-2">
          {log.role ? (
            <span className="font-mono text-xs text-foreground">{log.role}</span>
          ) : (
            "-"
          )}
        </td>
        <td className="px-3 py-2">
          {log.session_id ? (
            <div className="flex flex-col gap-0.5">
              {log.session_provider && (
                <StatusBadge semantic="neutral" className="w-fit">
                  {sessionProviderLabel(log.session_provider)}
                </StatusBadge>
              )}
              <span className="font-mono text-xs text-muted-foreground" title={log.session_id}>
                {shortSessionId(log.session_id)}
              </span>
            </div>
          ) : (
            "-"
          )}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-foreground">
          {log.request_model ?? "-"}
        </td>
        <td className="px-3 py-2 font-mono text-xs text-foreground">
          {log.upstream_model ?? "-"}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{log.channel_name ?? "-"}</td>
        <td className="px-3 py-2">
          {log.status_code == null ? (
            <span className="text-muted-foreground">-</span>
          ) : (
            <StatusBadge semantic={httpStatusSemantic(log.status_code)}>
              {log.status_code}
            </StatusBadge>
          )}
        </td>
        <td className="px-3 py-2">
          <StatusBadge semantic={riskSemantic(log.risk_level)}>{log.risk_level}</StatusBadge>
          {actionMarker(log.security_action, log.sanitized)}
        </td>
        <td className={NUMERIC_CELL}>{log.input_tokens}+{log.output_tokens}</td>
        <td className={NUMERIC_CELL}>
          {log.cache_read_tokens ? log.cache_read_tokens.toLocaleString() : "-"}
        </td>
        <td className={NUMERIC_CELL}>
          {log.cache_creation_tokens ? log.cache_creation_tokens.toLocaleString() : "-"}
        </td>
        <td className={NUMERIC_CELL}>
          {log.total_cost_usd ? formatUsd(log.total_cost_usd) : "-"}
        </td>
        <td className={NUMERIC_CELL}>{log.latency_ms}ms</td>
        <td className="px-3 py-2 text-muted-foreground">
          {log.fallback ? "是" : "-"}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/50">
          <td colSpan={16} className="px-3 py-2">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-mono">TraceID: {log.trace_id}</span>
                {log.error && <span className="text-destructive">{log.error}</span>}
                {log.risk_summary && <span className="text-warning">{log.risk_summary}</span>}
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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label: string; value: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[132px]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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

  // 统计与趋势随刷新 nonce 变化重新加载
  useEffect(() => {
    loadStatsTrend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  // 手动/自动刷新：拉取数据的同时通知顶栏同步网关状态
  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1);
    window.dispatchEvent(new CustomEvent("gateway-refresh"));
  }, []);

  // 自动刷新
  useEffect(() => {
    if (!secs) return;
    const t = setInterval(refresh, secs * 1000);
    return () => clearInterval(t);
  }, [secs, refresh]);

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

  // 统计带 4 项：总调用 / 成功率 / Token / 费用
  const statItems = useMemo(() => {
    if (!stats) return [];
    return [
      { label: "总调用", value: String(stats.total_calls) },
      { label: "成功率", value: successRate !== null ? `${successRate}%` : "—" },
      { label: "Token", value: totalTokens.toLocaleString() },
      { label: "费用", value: formatUsd(stats.cost ?? 0) },
    ];
  }, [stats, successRate, totalTokens]);

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
    <div>
      <PageHeader
        title="请求日志"
        description="查看网关请求记录、安全风险与调用趋势，可按会话分组浏览"
        action={
          <RefreshControls
            secs={secs}
            onSecsChange={setSecs}
            onRefresh={refresh}
          />
        }
      />
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="mb-4">
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
            <FilterSelect
              label="渠道"
              value={filter.channel_id || ALL}
              onChange={(v) => updateFilter({ channel_id: v === ALL ? undefined : v })}
              options={[{ label: "全部渠道", value: ALL }, ...channels.map((c) => ({ label: c.name, value: c.id }))]}
            />
            <FilterSelect
              label="密钥"
              value={filter.api_key_id || ALL}
              onChange={(v) => updateFilter({ api_key_id: v === ALL ? undefined : v })}
              options={[{ label: "全部密钥", value: ALL }, ...apiKeys.map((k) => ({ label: k.name, value: k.id }))]}
            />
            <FilterSelect
              label="角色"
              value={filter.role || ALL}
              onChange={(v) => updateFilter({ role: v === ALL ? undefined : v })}
              options={[{ label: "全部角色", value: ALL }, ...ROLES.map((r) => ({ label: r, value: r }))]}
            />
            <FilterSelect
              label="风险"
              value={filter.risk_level || ALL}
              onChange={(v) => updateFilter({ risk_level: v === ALL ? undefined : v })}
              options={[{ label: "全部风险", value: ALL }, ...RISK_LEVELS.map((l) => ({ label: l, value: l }))]}
            />
            <FilterSelect
              label="状态"
              value={filter.status || ALL}
              onChange={(v) => updateFilter({ status: v === ALL ? undefined : v as LogFilter["status"] })}
              options={STATUS_OPTIONS.map((s) => ({ label: s.label, value: s.value || ALL }))}
            />
            <FilterSelect
              label="流式"
              value={filter.is_stream === undefined ? ALL : String(filter.is_stream)}
              onChange={(v) => updateFilter({ is_stream: v === ALL ? undefined : v === "true" })}
              options={STREAM_OPTIONS.map((s) => ({ label: s.label, value: s.value === undefined ? ALL : String(s.value) }))}
            />
            <FilterSelect
              label="会话来源"
              value={filter.session_provider || ALL}
              onChange={(v) => updateFilter({ session_provider: v === ALL ? undefined : v })}
              options={SESSION_PROVIDERS.map((p) => ({ label: p.label, value: p.value || ALL }))}
            />
            <Input
              className="w-48"
              placeholder="Session ID"
              value={filter.session_id || ""}
              onChange={(e) => updateFilter({ session_id: e.target.value || undefined })}
            />
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
        <div
          data-testid="log-stat-strip"
          className="mb-4 flex flex-wrap items-center gap-x-10 gap-y-2 rounded-lg border border-border bg-card px-4 py-2.5"
        >
          {statItems.map((it) => (
            <div key={it.label} className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">{it.label}</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                {it.value}
              </span>
            </div>
          ))}
        </div>
      )}

      <Card className="mb-4">
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
                    <th className="px-3 py-2 font-medium">会话</th>
                    <th className="px-3 py-2 text-right font-medium">请求数</th>
                    <th className="px-3 py-2 font-medium">首次时间</th>
                    <th className="px-3 py-2 font-medium">最后时间</th>
                    <th className="px-3 py-2 font-medium">角色</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">风险</th>
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
                            className="px-3 py-2 font-mono text-xs text-foreground"
                            title={s.key}
                          >
                            <div className="flex items-center gap-2">
                              {isSessionGroup && s.logs[0]?.session_provider && (
                                <StatusBadge semantic="neutral">
                                  {sessionProviderLabel(s.logs[0].session_provider)}
                                </StatusBadge>
                              )}
                              <span>{isSessionGroup ? shortSessionId(s.key) : shortTrace(s.key)}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{s.logs.length}</td>
                          <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">
                            {new Date(first.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted-foreground">
                            {new Date(last.created_at * 1000).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {roles.length ? roles.join(" / ") : "-"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {statuses.length ? statuses.join(" / ") : "-"}
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge semantic={riskSemantic(worst)}>{worst}</StatusBadge>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="border-b border-border bg-muted/30">
                            <td colSpan={7} className="px-3 py-2">
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

      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">趋势</CardTitle>
          <SegmentedTabs
            value={dimension}
            onChange={setDimension}
            options={DIMENSION_TABS}
            ariaLabel="趋势维度"
          />
        </CardHeader>
        <CardContent>
          <LogTrendChart buckets={buckets} dimension={dimension} bucketSecs={bucketSize} />
        </CardContent>
      </Card>

      <div className="rounded-lg border border-border/60 bg-surface px-4 py-3">
        <div className="text-sm font-medium text-muted-foreground">日志清理</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
      </div>
    </div>
  );
}
