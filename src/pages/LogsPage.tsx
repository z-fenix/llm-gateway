import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ApiKey, Channel, LogFilter, LogStats, RequestLog, SecurityFinding, TimeBucket } from "../types";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";

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
    case "clean": return "bg-gray-100 text-gray-700";
    case "info": return "bg-blue-100 text-blue-700";
    case "low": return "bg-green-100 text-green-700";
    case "medium": return "bg-yellow-100 text-yellow-700";
    case "high": return "bg-orange-100 text-orange-700";
    case "critical": return "bg-red-100 text-red-700";
    default: return "bg-gray-100 text-gray-700";
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

  if (findings === null) return <div className="text-xs text-gray-500">加载 findings...</div>;
  if (findings.length === 0) return <div className="text-xs text-gray-500">无风险详情</div>;

  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li key={f.id} className="rounded border bg-white p-2 text-xs">
          <div className="flex gap-2 font-medium">
            <span className="rounded bg-gray-100 px-1">{f.severity}</span>
            <span>{f.title}</span>
            <span className="text-gray-500">({f.phase})</span>
          </div>
          {f.description && (
            <div className="mt-1 text-gray-600">{f.description}</div>
          )}
          {f.evidence_masked && (
            <div className="mt-1 font-mono text-gray-500">
              {f.evidence_masked}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function dateToSeconds(dateStr: string): number {
  if (!dateStr) return 0;
  return Math.floor(new Date(`${dateStr}T00:00:00`).getTime() / 1000);
}

function dateToEndOfDaySeconds(dateStr: string): number {
  if (!dateStr) return 0;
  return Math.floor(new Date(`${dateStr}T23:59:59`).getTime() / 1000);
}

function formatDateInput(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const ROLES = ["sonnet", "opus", "fable", "haiku"];
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

export default function LogsPage() {
  const [filter, setFilter] = useState<LogFilter>({});
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [buckets, setBuckets] = useState<TimeBucket[]>([]);
  const [dimension, setDimension] = useState<Dimension>("calls");
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

  const bucketSize = useMemo(() => {
    const after = filter.after;
    const before = filter.before;
    if (after && before) {
      return before - after <= 48 * 3600 ? 3600 : 86400;
    }
    return 86400;
  }, [filter.after, filter.before]);

  const loadList = () => {
    api.listLogs({ ...filter, limit, offset: page * limit })
      .then((res) => { setData(res); setError(null); })
      .catch(handleError);
  };

  const loadAll = () => {
    Promise.all([
      api.listLogs({ ...filter, limit, offset: page * limit }),
      api.getLogStats(filter),
      api.getLogTimeseries(filter, bucketSize),
    ]).then(([pageData, statsData, bucketsData]) => {
      setData(pageData);
      setStats(statsData);
      setBuckets(bucketsData);
      setError(null);
    }).catch(handleError);
  };

  useEffect(() => { loadList(); }, [page]);

  useEffect(() => {
    api.listChannels().then(setChannels).catch(handleError);
    api.listApiKeys().then(setApiKeys).catch(handleError);
    api.getLogRetentionDays().then((days) => {
      setRetentionDays(days);
      setRetentionInput(String(days));
    }).catch(handleError);
    loadAll();
  }, []);

  const updateFilter = (patch: Partial<LogFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch }));
  };

  const onSearch = () => {
    setPage(0);
    loadAll();
  };

  const successRate = useMemo(() => {
    if (!stats || stats.total_calls === 0) return null;
    return ((stats.success_count / stats.total_calls) * 100).toFixed(1);
  }, [stats]);

  const totalTokens = useMemo(() => {
    if (!stats) return 0;
    return stats.total_input_tokens + stats.total_output_tokens;
  }, [stats]);

  const onDeleteBefore = () => {
    if (!cleanupDate) return;
    const before = dateToEndOfDaySeconds(cleanupDate);
    if (!before) return;
    const msg = `确定删除 ${cleanupDate} 之前的全部日志？此操作不可恢复，并将级联删除关联的安全发现。`;
    if (!window.confirm(msg)) return;
    api.deleteLogsBefore(before).then(() => {
      setCleanupDate("");
      loadAll();
    }).catch(handleError);
  };

  const onClearAll = () => {
    const msg1 = "确定清空全部日志？此操作不可恢复，并将级联删除关联的安全发现。";
    const msg2 = "再次确认：将永久删除所有日志记录及关联发现，无法撤销。";
    if (!window.confirm(msg1)) return;
    if (!window.confirm(msg2)) return;
    api.clearLogs().then(() => {
      loadAll();
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
      <h1 className="mb-4 text-xl font-bold">请求日志</h1>
      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}

      <div className="mb-4 rounded border bg-white p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="border rounded px-2 py-1" placeholder="搜索 模型/渠道/TraceID/密钥"
            value={filter.keyword || ""} onChange={(e) => updateFilter({ keyword: e.target.value || undefined })} />
          <select className="border rounded px-2 py-1" value={filter.channel_id || ""}
            onChange={(e) => updateFilter({ channel_id: e.target.value || undefined })}>
            <option value="">全部渠道</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={filter.api_key_id || ""}
            onChange={(e) => updateFilter({ api_key_id: e.target.value || undefined })}>
            <option value="">全部密钥</option>
            {apiKeys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={filter.role || ""}
            onChange={(e) => updateFilter({ role: e.target.value || undefined })}>
            <option value="">全部角色</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={filter.risk_level || ""}
            onChange={(e) => updateFilter({ risk_level: e.target.value || undefined })}>
            <option value="">全部风险</option>
            {RISK_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={filter.status || ""}
            onChange={(e) => updateFilter({ status: e.target.value as LogFilter["status"] || undefined })}>
            {STATUS_OPTIONS.map((s) => <option key={s.label} value={s.value || ""}>{s.label}</option>)}
          </select>
          <select className="border rounded px-2 py-1" value={filter.is_stream === undefined ? "" : String(filter.is_stream)}
            onChange={(e) => {
              const v = e.target.value;
              updateFilter({ is_stream: v === "" ? undefined : v === "true" });
            }}>
            {STREAM_OPTIONS.map((s) => <option key={s.label} value={s.value === undefined ? "" : String(s.value)}>{s.label}</option>)}
          </select>
          <input type="date" className="border rounded px-2 py-1" value={formatDateInput(filter.after || 0)}
            onChange={(e) => updateFilter({ after: e.target.value ? dateToSeconds(e.target.value) : undefined })} />
          <input type="date" className="border rounded px-2 py-1" value={formatDateInput(filter.before || 0)}
            onChange={(e) => updateFilter({ before: e.target.value ? dateToEndOfDaySeconds(e.target.value) : undefined })} />
          <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={onSearch}>查询</button>
        </div>

        {stats && (
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded border p-2">
              <div className="text-xs text-gray-500">总调用</div>
              <div className="text-lg font-semibold">{stats.total_calls}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-xs text-gray-500">总 Token</div>
              <div className="text-lg font-semibold">{totalTokens.toLocaleString()}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-xs text-gray-500">成功率</div>
              <div className="text-lg font-semibold">{successRate !== null ? `${successRate}%` : (stats.total_calls === 0 ? "—" : "0%")}</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-xs text-gray-500">风险分布</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {stats.risk_distribution.length === 0 && <span className="text-xs text-gray-400">无</span>}
                {stats.risk_distribution.map(([level, count]) => (
                  <span key={level} className={`rounded px-1 text-xs ${riskBadgeClass(level)}`}>{level}: {count}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {stats && (
          <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded border p-2">
              <div className="mb-1 text-xs font-medium text-gray-600">Top 渠道</div>
              {stats.top_channels.length === 0 ? <div className="text-xs text-gray-400">无数据</div> : (
                <ul className="space-y-0.5">
                  {stats.top_channels.map(([name, count]) => (
                    <li key={name} className="flex justify-between text-xs"><span>{name}</span><span>{count}</span></li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded border p-2">
              <div className="mb-1 text-xs font-medium text-gray-600">Top 密钥</div>
              {stats.top_api_keys.length === 0 ? <div className="text-xs text-gray-400">无数据</div> : (
                <ul className="space-y-0.5">
                  {stats.top_api_keys.map(([name, count]) => (
                    <li key={name} className="flex justify-between text-xs"><span>{name}</span><span>{count}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 flex gap-2 border-b text-sm" role="tablist">
            {DIMENSION_TABS.map((tab) => (
              <button key={tab.value} role="tab" aria-selected={dimension === tab.value} onClick={() => setDimension(tab.value)}
                className={`px-2 py-1 ${dimension === tab.value ? "border-b-2 border-blue-600 font-medium text-blue-600" : "text-gray-600"}`}>
                {tab.label}
              </button>
            ))}
          </div>
          <LogTrendChart buckets={buckets} dimension={dimension} />
        </div>
      </div>

      <div className="mb-4 rounded border bg-white p-3">
        <div className="mb-2 text-sm font-medium text-gray-700">日志清理</div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-gray-600" htmlFor="cleanup-date">清理日期</label>
          <input id="cleanup-date" type="date" className="border rounded px-2 py-1" value={cleanupDate}
            onChange={(e) => setCleanupDate(e.target.value)} />
          <button className="rounded bg-orange-600 px-3 py-1 text-sm text-white" onClick={onDeleteBefore}>删除该日之前</button>
          <button className="rounded bg-red-600 px-3 py-1 text-sm text-white" onClick={onClearAll}>清空全部</button>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-sm text-gray-600" htmlFor="retention-days">日志保留天数</label>
            <input id="retention-days" type="number" min={0} className="w-20 border rounded px-2 py-1" value={retentionInput}
              onChange={(e) => setRetentionInput(e.target.value)} />
            <button className="rounded bg-gray-700 px-3 py-1 text-sm text-white" onClick={onSaveRetention}>保存</button>
            {retentionError && <span className="text-xs text-red-600">{retentionError}</span>}
            <span className="text-xs text-gray-500">当前: {retentionDays} 天</span>
          </div>
        </div>
      </div>

      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">#</th><th>时间</th><th>密钥</th><th>角色</th><th>请求模型</th><th>上游模型</th><th>渠道</th><th>状态</th><th>风险</th><th>Token</th><th>延迟</th><th>兜底</th>
        </tr></thead>
        <tbody>
          {data.items.map((l) => (
            <Fragment key={l.id}>
              <tr className="border-b cursor-pointer hover:bg-gray-50" onClick={() => setOpen(open === l.id ? null : l.id)}>
                <td className="p-2">{l.seq}</td>
                <td>{new Date(l.created_at * 1000).toLocaleTimeString()}</td>
                <td>{l.key_name}</td>
                <td>{l.role && <span className="rounded bg-purple-100 px-1 text-xs">{l.role}</span>}</td>
                <td>{l.request_model}</td>
                <td>{l.upstream_model}</td>
                <td>{l.channel_name}</td>
                <td className={l.status_code === 200 ? "text-green-600" : "text-red-600"}>{l.status_code ?? "-"}</td>
                <td>
                  <span className={`rounded px-1 text-xs ${riskBadgeClass(l.risk_level)}`}>{l.risk_level}</span>
                  {actionMarker(l.security_action, l.sanitized)}
                </td>
                <td>{l.input_tokens}+{l.output_tokens}</td>
                <td>{l.latency_ms}ms</td>
                <td>{l.fallback ? "是" : ""}</td>
              </tr>
              {open === l.id && (
                <tr className="border-b bg-gray-50">
                  <td colSpan={12} className="p-2">
                    <div className="text-xs text-gray-500">
                      TraceID: {l.trace_id}
                      {l.error && <span className="ml-2 text-red-600">{l.error}</span>}
                      {l.risk_summary && <span className="ml-2 text-orange-600">{l.risk_summary}</span>}
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{prettyJson(l.request_body)}</pre>
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{l.response_body ? prettyJson(l.response_body) : "(无响应体 / 流式)"}</pre>
                    </div>
                    {l.risk_level !== "clean" && (
                      <div className="mt-2">
                        <div className="mb-1 text-xs font-medium text-gray-600">风险详情</div>
                        <FindingsPanel logId={l.id} />
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <button disabled={page === 0} className="rounded border px-2 py-1" onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page + 1} 页 / 共 {Math.max(1, Math.ceil(data.total / limit))} 页（{data.total} 条）</span>
        <button disabled={(page + 1) * limit >= data.total} className="rounded border px-2 py-1" onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </div>
  );
}
