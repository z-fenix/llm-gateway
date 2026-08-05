import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ApiKey } from "../types";

export default function ApiKeysPage() {
  const [list, setList] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => api.listApiKeys().then(setList).catch(handleError);
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name) return;
    const q = quota.trim();
    const quotaNum = q && !isNaN(Number(q)) ? Number(q) : null;
    try {
      await api.createApiKey(name, quotaNum);
      setName(""); setQuota(""); load();
    } catch (err) {
      handleError(err);
    }
  };

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">API 密钥</h1>
      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      <div className="mb-4 flex gap-2">
        <input className="border rounded px-2 py-1" placeholder="用户/应用名" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="border rounded px-2 py-1" placeholder="Token 配额（留空不限）" value={quota} onChange={(e) => setQuota(e.target.value)} />
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={create}>生成密钥</button>
      </div>
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">名称</th><th>密钥</th><th>配额(已用/总量)</th><th>调用</th><th>Token</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          {list.map((k) => (
            <tr key={k.id} className="border-b">
              <td className="p-2">{k.name}</td>
              <td className="font-mono text-xs">{k.key}
                <button className="ml-1 text-blue-600" onClick={() => navigator.clipboard.writeText(k.key)}>复制</button></td>
              <td>{k.quota_used}/{k.quota_total ?? "∞"}</td>
              <td>{k.total_calls}</td><td>{k.total_tokens}</td>
              <td>{k.enabled ? "启用" : "禁用"}</td>
              <td className="space-x-2">
                <button className="text-blue-600" onClick={() => api.setApiKeyEnabled(k.id, !k.enabled).then(load).catch(handleError)}>{k.enabled ? "禁用" : "启用"}</button>
                <button className="text-red-600" onClick={() => api.deleteApiKey(k.id).then(load).catch(handleError)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
