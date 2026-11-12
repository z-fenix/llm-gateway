import { CircleAlert, CircleCheck, CircleHelp, CircleMinus, Timer } from "lucide-react";
import type { BreakerStatus, RoleRoute } from "../types";

export function aggregateBreaker(routes: RoleRoute[], statuses: Record<string, BreakerStatus>): string {
  if (!routes.length) return "unconfigured";
  const states = routes.map(route => statuses[route.id]?.state);
  if (states.includes("open")) return "open";
  if (states.includes("half_open")) return "half_open";
  return states.every(state => state === "closed") ? "closed" : "unknown";
}

export function BreakerIndicator({ state }: { state?: string }) {
  const [Icon, label, color] = state === "closed" ? [CircleCheck, "正常", "text-success"] as const
    : state === "open" ? [CircleAlert, "已熔断", "text-destructive"] as const
    : state === "half_open" ? [Timer, "半开", "text-warning"] as const
    : state === "unconfigured" ? [CircleMinus, "未配置", "text-muted-foreground"] as const
    : [CircleHelp, "状态未知", "text-muted-foreground"] as const;
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground"><Icon aria-hidden="true" className={`h-3.5 w-3.5 ${color}`} />{label}</span>;
}
