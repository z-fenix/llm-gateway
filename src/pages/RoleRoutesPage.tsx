import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Channel, RolePattern, RoleRoute } from "../types";

const ROLES = ["sonnet", "opus", "fable", "haiku"];

export default function RoleRoutesPage() {
  const [routes, setRoutes] = useState<RoleRoute[]>([]);
  const [patterns, setPatterns] = useState<RolePattern[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [fallback, setFallbackState] = useState<[string, string] | null>(null);

  const load = () => {
    api.listRoleRoutes().then(setRoutes).catch(console.error);
    api.listRolePatterns().then(setPatterns).catch(console.error);
    api.listChannels().then(setChannels).catch(console.error);
    api.getFallback().then(setFallbackState).catch(console.error);
  };
  useEffect(() => { load(); }, []);

  const routeFor = (role: string) => routes.find((r) => r.role === role);

  const bind = async (role: string, channel_id: string, target_model: string) => {
    if (!channel_id) { await api.deleteRoleRoute(role); } else { await api.setRoleRoute(role, channel_id, target_model); }
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-xl font-bold">角色路由</h1>
        <p className="mb-3 text-sm text-gray-500">Claude Code 请求里的角色 → 固定走指定渠道的上游模型；失败走全局兜底。</p>
        <table className="w-full border bg-white text-sm">
          <thead><tr className="border-b text-left"><th className="p-2">角色</th><th>渠道</th><th>上游模型</th></tr></thead>
          <tbody>
            {ROLES.map((role) => {
              const r = routeFor(role);
              return (
                <tr key={role} className="border-b">
                  <td className="p-2 font-medium">{role}</td>
                  <td>
                    <select className="border rounded px-2 py-1" value={r?.channel_id ?? ""}
                      onChange={(e) => bind(role, e.target.value, r?.target_model ?? "")}>
                      <option value="">（不路由 / 走普通调度）</option>
                      {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="w-full border rounded px-2 py-1" placeholder="上游模型，如 deepseek-v4-flash"
                      defaultValue={r?.target_model ?? ""} disabled={!r?.channel_id}
                      onBlur={(e) => r?.channel_id && bind(role, r.channel_id, e.target.value)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">全局兜底模型</h2>
        <div className="flex gap-2">
          <select className="border rounded px-2 py-1" value={fallback?.[0] ?? ""}
            onChange={(e) => e.target.value ? api.setFallback(e.target.value, fallback?.[1] ?? "").then(load) : api.clearFallback().then(load)}>
            <option value="">（无兜底）</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="border rounded px-2 py-1" placeholder="兜底上游模型" defaultValue={fallback?.[1] ?? ""}
            disabled={!fallback?.[0]}
            onBlur={(e) => fallback?.[0] && api.setFallback(fallback[0], e.target.value).then(load)} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 font-semibold">角色识别规则</h2>
        <table className="w-full border bg-white text-sm">
          <thead><tr className="border-b text-left"><th className="p-2">模式</th><th>角色</th><th>优先级</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="p-2 font-mono">{p.pattern}</td>
                <td>{p.role}</td><td>{p.priority}</td>
                <td>{p.enabled ? "启用" : "禁用"}</td>
                <td><button className="text-red-600" onClick={() => api.deleteRolePattern(p.id).then(load)}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
