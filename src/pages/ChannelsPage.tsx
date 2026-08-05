import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Channel } from "../types";
import ChannelForm from "../components/ChannelForm";

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [creating, setCreating] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => api.listChannels().then(setList).catch(handleError);
  useEffect(() => { load(); }, []);

  const save = async (c: Channel) => {
    try {
      if (c.id) await api.updateChannel(c); else await api.createChannel(c);
      setCreating(false); setEditing(null); load();
    } catch (err) {
      handleError(err);
    }
  };
  const test = async (id: string) => {
    try {
      const r = await api.testChannel(id);
      setTestMsg((m) => ({ ...m, [id]: r.ok ? `✓ ${r.latency_ms}ms` : `✗ ${r.error}` }));
    } catch (err) {
      handleError(err);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">渠道管理</h1>
        <button className="rounded bg-blue-600 px-3 py-1 text-white" onClick={() => setCreating(true)}>新建渠道</button>
      </div>
      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
      {(creating || editing) && (
        <div className="mb-4">
          <ChannelForm initial={editing ?? undefined} onSubmit={save} onCancel={() => { setCreating(false); setEditing(null); }} />
        </div>
      )}
      <table className="w-full border bg-white text-sm">
        <thead><tr className="border-b text-left">
          <th className="p-2">名称</th><th>类型</th><th>Base URL</th><th>优先级/权重</th><th>模型</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id} className="border-b">
              <td className="p-2">{c.name}</td>
              <td>{c.provider_type}</td>
              <td className="max-w-[180px] truncate">{c.base_url}</td>
              <td>{c.priority}/{c.weight}</td>
              <td className="max-w-[160px] truncate">{c.models.join(",")}</td>
              <td>{c.enabled ? "启用" : "禁用"}</td>
              <td className="space-x-2">
                <button className="text-blue-600" onClick={() => setEditing(c)}>编辑</button>
                <button className="text-green-600" onClick={() => test(c.id)}>测试</button>
                <button className="text-red-600" onClick={() => api.deleteChannel(c.id).then(load).catch(handleError)}>删除</button>
                {testMsg[c.id] && <span className="text-xs">{testMsg[c.id]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
