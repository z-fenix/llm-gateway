import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "../lib/utils";
import type { TimeBucket } from "../types";

export type Dimension = "calls" | "tokens" | "success" | "risk";

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
    .filter((p) => p.value !== undefined && p.value !== null && p.value !== 0)
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
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: e.color }}
            />
            <span className="text-muted-foreground">{e.name}:</span>
            <span className="font-medium text-foreground">
              {dimension === "success" ? `${e.value}%` : String(e.value)}
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

  return (
    <div className="h-[220px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="colorCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorInput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorOutput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="hsl(var(--border))"
            opacity={0.4}
          />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            dy={10}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
            tickFormatter={(v: number) =>
              dimension === "success"
                ? `${v}%`
                : v >= 1000
                  ? `${(v / 1000).toFixed(1)}k`
                  : String(v)
            }
            width={44}
          />
          <Tooltip content={<CustomTooltip dimension={dimension} />} />
          {dimension === "calls" && (
            <Area
              type="monotone"
              dataKey="calls"
              name="调用量"
              stroke="#3b82f6"
              strokeWidth={2}
              fill="url(#colorCalls)"
            />
          )}
          {dimension === "tokens" && (
            <>
              <Area
                type="monotone"
                dataKey="input"
                name="输入 Tokens"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#colorInput)"
              />
              <Area
                type="monotone"
                dataKey="output"
                name="输出 Tokens"
                stroke="#22c55e"
                strokeWidth={2}
                fill="url(#colorOutput)"
              />
            </>
          )}
          {dimension === "success" && (
            <Area
              type="monotone"
              dataKey="success"
              name="成功率"
              stroke="#22c55e"
              strokeWidth={2}
              fill="none"
            />
          )}
          {dimension === "risk" &&
            RISK_ORDER.map((l) => (
              <Area
                key={l}
                type="monotone"
                dataKey={l}
                name={RISK_LABELS[l] || l}
                stackId="risk"
                stroke={RISK_COLORS[l]}
                fill={RISK_COLORS[l]}
                fillOpacity={0.6}
                strokeWidth={1}
              />
            ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
