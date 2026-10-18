import * as React from "react";

import { cn } from "../lib/utils";

export interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  progress?: number;
  className?: string;
}

export function StatCard({ label, value, hint, progress, className }: StatCardProps) {
  const clamped =
    progress === undefined ? undefined : Math.max(0, Math.min(100, progress));

  return (
    <div className={cn("w-full", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-foreground">
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      {clamped !== undefined ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${clamped}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
