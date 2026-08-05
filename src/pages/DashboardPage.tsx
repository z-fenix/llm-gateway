import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Stats } from "../types";

export default function DashboardPage() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => { api.getStats().then(setS).catch(console.error); }, []);
  if (!s) return <div>加载中…</div>;
  const cards = [
    { label: "今日请求", value: s.today_requests },
    { label: "今日 Token", value: s.today_tokens },
    { label: "累计请求", value: s.total_requests },
    { label: "累计 Token", value: s.total_tokens },
    { label: "活跃渠道", value: s.active_channels },
    { label: "平均延迟(ms)", value: s.avg_latency_ms },
  ];
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">概览</h1>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border bg-white p-4">
            <div className="text-sm text-gray-500">{c.label}</div>
            <div className="mt-1 text-2xl font-bold">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
