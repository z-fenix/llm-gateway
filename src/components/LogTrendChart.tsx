import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeBucket } from "../types";
import { formatUsd, formatUsdAxis } from "../lib/usage";

export type Dimension = "calls" | "tokens" | "success" | "risk" | "cache" | "cost";

export function niceCeil(n: number): number {
  if (n <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  const normalized = n / magnitude;
  if (normalized <= 1) return magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

export function formatBucketLabel(bucketSecs: number, ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (bucketSecs >= 86400) {
    return `${month}-${day}`;
  }
  const hour = String(d.getHours()).padStart(2, "0");
  return `${month}-${day} ${hour}:00`;
}

export function computeTicks(
  buckets: TimeBucket[],
  bucketSecs: number
): {
  xLabels: { i: number; label: string }[];
} {
  if (buckets.length === 0) {
    return { xLabels: [] };
  }
  const target = 6;
  const step = Math.max(1, Math.floor(buckets.length / target));
  const xLabels: { i: number; label: string }[] = [];
  for (let i = 0; i < buckets.length; i += step) {
    xLabels.push({ i, label: formatBucketLabel(bucketSecs, buckets[i].bucket * 1000) });
  }
  const last = buckets.length - 1;
  if (last % step !== 0) {
    xLabels.push({ i: last, label: formatBucketLabel(bucketSecs, buckets[last].bucket * 1000) });
  }
  return { xLabels };
}

export function stackSums(b: TimeBucket): number {
  return Object.values(b.risk_counts).reduce((sum, v) => sum + (v || 0), 0);
}

const RISK_ORDER = ["clean", "info", "low", "medium", "high", "critical"];

const RISK_COLORS: Record<string, string> = {
  clean: "#9ca3af",
  info: "#3b82f6",
  low: "#22c55e",
  medium: "#eab308",
  high: "#f97316",
  critical: "#ef4444",
};

const RISK_LABELS: Record<string, string> = {
  clean: "无风险",
  info: "信息",
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "严重",
};

function successRate(b: TimeBucket): number {
  if (b.calls === 0) return 0;
  return Math.round(((b.calls - b.error_count) / b.calls) * 1000) / 10;
}

type TooltipEntry = {
  name?: string;
  value?: number | string;
  color?: string;
  stroke?: string;
  fill?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
};

function CustomTooltip({
  active,
  payload,
  label,
  dimension,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  dimension: Dimension;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const entries = payload
    .filter((p) => p.value !== undefined && p.value !== null)
    .map((p) => ({
      name: p.name ?? String(p.dataKey),
      value: p.value,
      color: p.color ?? p.stroke ?? p.fill ?? "#6b7280",
    }));

  return (
    <div className="rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-md">
      <div className="mb-1 text-xs font-medium text-foreground">{label}</div>
      <div className="space-y-1">
        {entries.length === 0 && (
          <div className="text-xs text-muted-foreground">无数据</div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <svg className="h-2 w-3 shrink-0" aria-hidden="true"><rect width="12" height="3" y="2" fill={e.color} /></svg>
            <span className="text-muted-foreground">{e.name}:</span>
            <span className="font-medium text-foreground">
              {dimension === "success"
                ? `${e.value}%`
                : dimension === "cost"
                  ? formatUsd(Number(e.value))
                  : String(e.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LogTrendChart({
  buckets,
  dimension,
  bucketSecs,
}: {
  buckets: TimeBucket[];
  dimension: Dimension;
  bucketSecs: number;
}) {
  const chartData = useMemo(
    () =>
      buckets.map((b) => ({
        label: formatBucketLabel(bucketSecs, b.bucket * 1000),
        calls: b.calls,
        input: b.input_tokens,
        output: b.output_tokens,
        cache_read: b.cache_read_tokens || 0,
        cache_creation: b.cache_creation_tokens || 0,
        cost: b.cost || 0,
        success: successRate(b),
        ...Object.fromEntries(RISK_ORDER.map((l) => [l, b.risk_counts[l] || 0])),
      })),
    [buckets, bucketSecs]
  );

  if (buckets.length === 0) {
    return (
      <div className="flex h-[180px] w-full items-center justify-center rounded border border-dashed border-gray-300 bg-muted text-sm text-muted-foreground">
        暂无数据
      </div>
    );
  }

  const series = dimension === "calls" ? [{ key: "calls", name: "调用量", color: "var(--chart-1)" }]
    : dimension === "tokens" ? [{ key: "input", name: "输入 Tokens", color: "var(--chart-1)" }, { key: "output", name: "输出 Tokens", color: "var(--chart-2)" }]
    : dimension === "cache" ? [{ key: "cache_creation", name: "缓存创建", color: "var(--chart-2)" }, { key: "cache_read", name: "缓存命中", color: "var(--chart-3)" }]
    : dimension === "success" ? [{ key: "success", name: "成功率", color: "hsl(var(--success))" }]
    : dimension === "cost" ? [{ key: "cost", name: "费用", color: "var(--chart-1)" }]
    : RISK_ORDER.map((key) => ({ key, name: RISK_LABELS[key], color: RISK_COLORS[key] }));
  const axes = <><CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.45} />
    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} minTickGap={36} dy={8} />
    <YAxis axisLine={false} tickLine={false} width={46} domain={dimension === "success" ? [0, 100] : [0, "auto"]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(v: number) => dimension === "success" ? `${v}%` : dimension === "cost" ? formatUsdAxis(v) : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)} />
    <Tooltip content={<CustomTooltip dimension={dimension} />} /></>;
  return (
    <div className="min-w-0 space-y-4">
      <div className="h-[220px] w-full" aria-label={`${series.map((s) => s.name).join("、")}趋势图`}>
        <ResponsiveContainer width="100%" height="100%">
          {dimension === "calls" ? <BarChart data={chartData} accessibilityLayer margin={{ top: 10, right: 12, left: 0, bottom: 10 }}>{axes}<Bar dataKey="calls" name="调用量" fill="var(--chart-1)" maxBarSize={18} radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart>
            : <AreaChart data={chartData} accessibilityLayer margin={{ top: 10, right: 12, left: 0, bottom: 10 }}>{axes}{series.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.1} stackId={dimension === "risk" ? "risk" : undefined} isAnimationActive={false} activeDot={{ r: 4, stroke: "hsl(var(--card))", strokeWidth: 2 }} />)}</AreaChart>}
        </ResponsiveContainer>
      </div>
      {series.length > 1 && <ul aria-label="图例" className="flex flex-wrap justify-center gap-x-5 gap-y-2">{series.map((s) => <li key={s.key} className="flex items-center gap-2 text-[11px] text-muted-foreground"><svg className="h-2 w-3 shrink-0" aria-hidden="true"><rect width="12" height="3" y="2" fill={s.color} /></svg>{s.name}</li>)}</ul>}
      <details className="rounded-xl bg-background/70 px-4 py-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">查看数据</summary><div className="mt-3 max-h-64 overflow-auto"><table className="data-table"><caption className="sr-only">与趋势图同口径的数据表</caption><thead><tr><th>时间</th>{series.map((s) => <th key={s.key}>{s.name}</th>)}</tr></thead><tbody>{chartData.map((row, index) => <tr key={index}><td>{row.label}</td>{series.map((s) => <td key={s.key}>{dimension === "cost" ? formatUsd(Number((row as Record<string, unknown>)[s.key])) : dimension === "success" ? `${(row as Record<string, unknown>)[s.key]}%` : Number((row as Record<string, unknown>)[s.key]).toLocaleString()}</td>)}</tr>)}</tbody></table></div></details>
    </div>
  );
}
