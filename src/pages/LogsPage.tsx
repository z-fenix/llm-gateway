import { Fragment, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RequestLog, SecurityFinding } from "../types";

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

export default function LogsPage() {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => {
    setError(null);
    api.listLogs(keyword || null, limit, page * limit).then(setData).catch(handleError);
  };
  useEffect(() => { load(); }, [page]);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">请求日志</h1>
      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      <div className="mb-3 flex gap-2">
        <input className="border rounded px-2 py-1" placeholder="搜索 模型/渠道/TraceID/密钥"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => { setPage(0); load(); }}>搜索</button>
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
