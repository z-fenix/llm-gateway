import { useState } from "react";
import type { Channel } from "../types";

const SUPPLIERS = ["openai", "claude", "deepseek", "gemini", "custom"];
const UPSTREAM_PROTOCOLS = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses API" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini-native", label: "Gemini Native" },
];

type FieldErrors = Partial<Record<keyof Channel, string>>;

/** 前端与后端同一套校验规则（后端为准）。 */
function validateForm(f: Partial<Channel>): FieldErrors {
  const errs: FieldErrors = {};
  if (!(f.name ?? "").trim()) errs.name = "名称不能为空";
  const baseUrl = (f.base_url ?? "").trim();
  if (!baseUrl) errs.base_url = "Base URL 不能为空";
  else {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errs.base_url = "Base URL 必须是 http/https 地址";
      }
    } catch {
      errs.base_url = "Base URL 格式无效";
    }
  }
  if (!(f.api_key ?? "").trim()) errs.api_key = "API Key 不能为空";
  if (!(f.models ?? []).some((m) => m.trim())) errs.models = "至少需要一个模型";
  if ((f.timeout_secs ?? 0) < 1) errs.timeout_secs = "超时时间必须大于等于 1 秒";
  return errs;
}

export default function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (c: Channel) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<Channel>>({
    supplier: "openai", upstream_protocol: "openai-chat", priority: 0, weight: 1, enabled: true,
    timeout_secs: 60, models: [], ...initial,
  });
  const [attempted, setAttempted] = useState(false);
  // 提交过一次后才展示错误，之后随输入实时更新
  const errors = attempted ? validateForm(f) : {};
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));
  const inputCls = (k: keyof Channel) =>
    `w-full border rounded px-2 py-1${errors[k] ? " border-red-500 bg-red-50" : ""}`;
  const errMsg = (k: keyof Channel) =>
    errors[k] ? <p className="mt-1 text-xs text-red-600">{errors[k]}</p> : null;

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validateForm(f)).length > 0) return;
    onSubmit(f as Channel);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-white p-4">
      <div>
        <input className={inputCls("name")} placeholder="名称" value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} />
        {errMsg("name")}
      </div>
      <select className="w-full border rounded px-2 py-1" value={f.supplier} onChange={(e) => set("supplier", e.target.value)}>
        {SUPPLIERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select className="w-full border rounded px-2 py-1" value={f.upstream_protocol} onChange={(e) => set("upstream_protocol", e.target.value)}>
        {UPSTREAM_PROTOCOLS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <div>
        <input className={inputCls("base_url")} placeholder="Base URL，如 https://api.deepseek.com" value={f.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} />
        {errMsg("base_url")}
      </div>
      <div>
        <input className={inputCls("api_key")} placeholder="真实上游 API Key" value={f.api_key ?? ""} onChange={(e) => set("api_key", e.target.value)} />
        {errMsg("api_key")}
      </div>
      <div>
        <input className={inputCls("models")} placeholder="支持模型（逗号分隔）" value={(f.models ?? []).join(",")} onChange={(e) => set("models", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        {errMsg("models")}
      </div>
      <div className="flex gap-2">
        <div className="w-1/2">
          <input type="number" className={inputCls("priority")} placeholder="优先级" value={f.priority ?? 0} onChange={(e) => set("priority", Number(e.target.value))} />
          {errMsg("priority")}
        </div>
        <div className="w-1/2">
          <input type="number" className={inputCls("weight")} placeholder="权重" value={f.weight ?? 1} onChange={(e) => set("weight", Number(e.target.value))} />
          {errMsg("weight")}
        </div>
      </div>
      <div>
        <input type="number" className={inputCls("timeout_secs")} placeholder="超时秒数（>=1）" value={f.timeout_secs ?? 0} onChange={(e) => set("timeout_secs", Number(e.target.value))} />
        {errMsg("timeout_secs")}
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded border px-3 py-1" onClick={onCancel}>取消</button>
        <button className="rounded bg-blue-600 px-3 py-1 text-white"
          onClick={submit}>保存</button>
      </div>
    </div>
  );
}
