import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RequestLog } from "../types";

export default function LogsPage() {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ items: RequestLog[]; total: number }>({ items: [], total: 0 });
  const [open, setOpen] = useState<string | null>(null);
  const limit = 20;

  const load = () => api.listLogs(keyword || null, limit, page * limit).then(setData).catch(console.error);
  useEffect(() => { load(); }, [page]);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">请求日志</h1>
      <div className="mb-3 flex gap-2">
        <input className="border rounded px-2 py-1" placeholder="搜索 模型/渠道/TraceID/密钥"
          value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => { setPage(0); load(); }}>搜索</button>
      </div>
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">#</th><th>时间</th><th>密钥</th><th>角色</th><th>请求模型</th><th>上游模型</th><th>渠道</th><th>状态</th><th>Token</th><th>延迟</th><th>兜底</th>
        </tr></thead>
        <tbody>
          {data.items.map((l) => (
            <>
              <tr key={l.id} className="border-b cursor-pointer hover:bg-gray-50" onClick={() => setOpen(open === l.id ? null : l.id)}>
                <td className="p-2">{l.seq}</td>
                <td>{new Date(l.created_at * 1000).toLocaleTimeString()}</td>
                <td>{l.key_name}</td>
                <td>{l.role && <span className="rounded bg-purple-100 px-1 text-xs">{l.role}</span>}</td>
                <td>{l.request_model}</td>
                <td>{l.upstream_model}</td>
                <td>{l.channel_name}</td>
                <td className={l.status_code === 200 ? "text-green-600" : "text-red-600"}>{l.status_code ?? "-"}</td>
                <td>{l.input_tokens}+{l.output_tokens}</td>
                <td>{l.latency_ms}ms</td>
                <td>{l.fallback ? "是" : ""}</td>
              </tr>
              {open === l.id && (
                <tr key={l.id + "-d"} className="border-b bg-gray-50">
                  <td colSpan={11} className="p-2">
                    <div className="text-xs text-gray-500">TraceID: {l.trace_id}{l.error && <span className="ml-2 text-red-600">{l.error}</span>}</div>
                    <div className="mt-1 grid grid-cols-2 gap-2">
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{JSON.stringify(JSON.parse(l.request_body ?? "{}"), null, 2)}</pre>
                      <pre className="max-h-48 overflow-auto rounded border bg-white p-2 text-xs">{l.response_body ? JSON.stringify(JSON.parse(l.response_body), null, 2) : "(无响应体 / 流式)"}</pre>
                    </div>
                  </td>
                </tr>
              )}
            </>
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
