import { useState } from "react";
import type { Channel } from "../types";

const SUPPLIERS = ["openai", "claude", "deepseek", "gemini", "custom"];
const UPSTREAM_PROTOCOLS = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses API" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini-native", label: "Gemini Native" },
];

export default function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (c: Channel) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<Channel>>({
    supplier: "openai", upstream_protocol: "openai-chat", priority: 0, weight: 1, enabled: true,
    timeout_secs: 60, models: [], ...initial,
  });
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div className="space-y-3 rounded-lg border bg-white p-4">
      <input className="w-full border rounded px-2 py-1" placeholder="名称" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} />
      <select className="w-full border rounded px-2 py-1" value={f.supplier} onChange={(e) => set("supplier", e.target.value)}>
        {SUPPLIERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select className="w-full border rounded px-2 py-1" value={f.upstream_protocol} onChange={(e) => set("upstream_protocol", e.target.value)}>
        {UPSTREAM_PROTOCOLS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <input className="w-full border rounded px-2 py-1" placeholder="Base URL，如 https://api.deepseek.com" value={f.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} />
      <input className="w-full border rounded px-2 py-1" placeholder="真实上游 API Key" value={f.api_key ?? ""} onChange={(e) => set("api_key", e.target.value)} />
      <input className="w-full border rounded px-2 py-1" placeholder="支持模型（逗号分隔）" value={(f.models ?? []).join(",")} onChange={(e) => set("models", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
      <div className="flex gap-2">
        <input type="number" className="w-1/2 border rounded px-2 py-1" placeholder="优先级" value={f.priority ?? 0} onChange={(e) => set("priority", Number(e.target.value))} />
        <input type="number" className="w-1/2 border rounded px-2 py-1" placeholder="权重" value={f.weight ?? 1} onChange={(e) => set("weight", Number(e.target.value))} />
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded border px-3 py-1" onClick={onCancel}>取消</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-white"
          onClick={() => onSubmit(f as Channel)}>保存</button>
      </div>
    </div>
  );
}
