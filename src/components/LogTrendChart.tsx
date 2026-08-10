import { useEffect, useRef, useState } from "react";
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

const MARGIN = { top: 24, right: 16, bottom: 32, left: 48 };
const CSS_HEIGHT = 180;

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; bucket: TimeBucket } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || buckets.length === 0) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const draw = () => {
      try {
        const rect = container.getBoundingClientRect();
        const cssWidth = Math.max(rect.width, 200);
        const cssHeight = CSS_HEIGHT;
        const dpr = window.devicePixelRatio || 1;

        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const chartW = cssWidth - MARGIN.left - MARGIN.right;
        const chartH = cssHeight - MARGIN.top - MARGIN.bottom;

        let yMax = 1;
        if (dimension === "calls") {
          yMax = niceCeil(Math.max(1, ...buckets.map((b) => b.calls)));
        } else if (dimension === "tokens") {
          yMax = niceCeil(Math.max(1, ...buckets.map((b) => Math.max(b.input_tokens, b.output_tokens))));
        } else if (dimension === "success") {
          yMax = 100;
        } else if (dimension === "risk") {
          yMax = niceCeil(Math.max(1, ...buckets.map(stackSums)));
        }

        // horizontal grid lines
        ctx.strokeStyle = "#e5e7eb";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
          const y = MARGIN.top + (chartH * i) / 4;
          ctx.moveTo(MARGIN.left, y);
          ctx.lineTo(MARGIN.left + chartW, y);
        }
        ctx.stroke();

        // y-axis labels
        ctx.fillStyle = "#6b7280";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let i = 0; i <= 4; i++) {
          const value = yMax * (1 - i / 4);
          const y = MARGIN.top + (chartH * i) / 4;
          ctx.fillText(dimension === "success" ? `${Math.round(value)}%` : formatNumber(value), MARGIN.left - 6, y);
        }

        // x-axis labels
        const { xLabels } = computeTicks(buckets, bucketSecs);
        ctx.fillStyle = "#6b7280";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (const { i, label } of xLabels) {
          const x = MARGIN.left + (i / (buckets.length - 1 || 1)) * chartW;
          ctx.fillText(label, x, MARGIN.top + chartH + 6);
        }

        // axes
        ctx.strokeStyle = "#d1d5db";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN.left, MARGIN.top);
        ctx.lineTo(MARGIN.left, MARGIN.top + chartH);
        ctx.lineTo(MARGIN.left + chartW, MARGIN.top + chartH);
        ctx.stroke();

        const slotW = chartW / buckets.length;
        const barPad = slotW * 0.2;
        const barW = Math.max(slotW - barPad * 2, 1);

        if (dimension === "calls") {
          ctx.fillStyle = "#3b82f6";
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            const h = (b.calls / yMax) * chartH;
            const x = MARGIN.left + i * slotW + barPad;
            const y = MARGIN.top + chartH - h;
            ctx.fillRect(x, y, barW, h);
          }
        } else if (dimension === "tokens") {
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            const x = MARGIN.left + (i + 0.5) * slotW;
            const y = MARGIN.top + chartH - (b.input_tokens / yMax) * chartH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();

          ctx.strokeStyle = "#22c55e";
          ctx.beginPath();
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            const x = MARGIN.left + (i + 0.5) * slotW;
            const y = MARGIN.top + chartH - (b.output_tokens / yMax) * chartH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();

          ctx.font = "11px sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#3b82f6";
          ctx.fillText("● input", MARGIN.left + 8, MARGIN.top - 8);
          ctx.fillStyle = "#22c55e";
          ctx.fillText("● output", MARGIN.left + 64, MARGIN.top - 8);
        } else if (dimension === "success") {
          ctx.strokeStyle = "#22c55e";
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            const rate = (b.calls - b.error_count) / Math.max(b.calls, 1);
            const x = MARGIN.left + (i + 0.5) * slotW;
            const y = MARGIN.top + chartH - rate * chartH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        } else if (dimension === "risk") {
          for (let i = 0; i < buckets.length; i++) {
            const b = buckets[i];
            const x = MARGIN.left + i * slotW + barPad;
            let yBottom = MARGIN.top + chartH;
            for (const level of RISK_ORDER) {
              const count = b.risk_counts[level] || 0;
              if (count <= 0) continue;
              const h = (count / yMax) * chartH;
              ctx.fillStyle = RISK_COLORS[level] || "#9ca3af";
              ctx.fillRect(x, yBottom - h, barW, h);
              yBottom -= h;
            }
          }
        }
      } catch (err) {
        console.error("LogTrendChart draw failed", err);
      }
    };

    draw();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(draw);
      ro.observe(container);
    }
    return () => ro?.disconnect();
  }, [buckets, dimension]);

  const handleMouseMove: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    if (buckets.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const chartW = rect.width - MARGIN.left - MARGIN.right;
    const slotW = chartW / buckets.length;
    const i = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((e.nativeEvent.offsetX - MARGIN.left + slotW / 2) / slotW))
    );
    setHover({ x: e.nativeEvent.offsetX + 12, y: e.nativeEvent.offsetY - 12, bucket: buckets[i] });
  };

  const handleMouseLeave = () => setHover(null);

  if (buckets.length === 0) {
    return (
      <div className="flex h-[180px] w-full items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-500">
        暂无数据
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        className="block w-full rounded border border-gray-200"
        style={{ height: CSS_HEIGHT }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-gray-200 bg-white px-2 py-1 text-xs shadow"
          style={{ left: hover.x, top: hover.y }}
        >
          <div className="font-medium text-gray-700">{formatBucketLabel(bucketSecs, hover.bucket.bucket * 1000)}</div>
          {dimension === "calls" && <div className="text-blue-600">calls: {hover.bucket.calls}</div>}
          {dimension === "tokens" && (
            <>
              <div className="text-blue-600">input: {hover.bucket.input_tokens}</div>
              <div className="text-green-600">output: {hover.bucket.output_tokens}</div>
            </>
          )}
          {dimension === "success" && (
            <div className="text-green-600">
              success: {Math.round(((hover.bucket.calls - hover.bucket.error_count) / Math.max(hover.bucket.calls, 1)) * 100)}%
            </div>
          )}
          {dimension === "risk" && (
            <div className="space-y-0.5">
              {RISK_ORDER.map((level) =>
                hover.bucket.risk_counts[level] ? (
                  <div key={level} className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: RISK_COLORS[level] }} />
                    <span className="text-gray-600">
                      {level}: {hover.bucket.risk_counts[level]}
                    </span>
                  </div>
                ) : null
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
