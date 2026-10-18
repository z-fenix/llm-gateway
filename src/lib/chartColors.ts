import { riskSemantic, type Semantic } from "./semantics";

/**
 * 趋势图系列色（方向 A · 青碧信号）。
 *
 * 返回 `hsl(var(--...))` 形式的 CSS 色（令牌为 HSL 三元组），供 recharts 的
 * stroke/fill/stopColor 使用；具体色值全部收敛到 `src/index.css` 的设计令牌，
 * 一处定义处处引用。
 */
export type Dimension =
  | "calls"
  | "tokens"
  | "success"
  | "risk"
  | "cache"
  | "cost";

const NEUTRAL = "hsl(var(--muted-foreground))";
const PRIMARY = "hsl(var(--primary))";

/** 语义色 → CSS 变量。danger 设计上映射到 --destructive（无 --danger 变量）。
 *  令牌为 HSL 三元组，须以 hsl(var(--x)) 包裹才是合法 CSS 色。 */
const SEMANTIC_VAR: Record<Semantic, string> = {
  neutral: NEUTRAL,
  info: "hsl(var(--info))",
  success: "hsl(var(--success))",
  warning: "hsl(var(--warning))",
  danger: "hsl(var(--destructive))",
};

/** Token 维度 4 系列定稿：input=中性灰、output=primary、cache_read=info、cache_creation=warning。 */
const TOKEN_SERIES: Record<string, string> = {
  input: NEUTRAL,
  output: PRIMARY,
  cache_read: "hsl(var(--info))",
  cache_creation: "hsl(var(--warning))",
};

/** 缓存维度系列：读=info、创建=warning，其余主系列回退 primary。 */
const CACHE_SERIES: Record<string, string> = {
  cache_read: "hsl(var(--info))",
  cache_creation: "hsl(var(--warning))",
};

function riskColor(key: string): string {
  const k = key.trim().toLowerCase();
  // high 与 critical 同为 danger，high 降 20% 不透明度以示两档可辨
  if (k === "high") {
    return "color-mix(in srgb, hsl(var(--destructive)) 80%, transparent)";
  }
  return SEMANTIC_VAR[riskSemantic(k)];
}

function successColor(key: string): string {
  const k = key.trim().toLowerCase();
  return k === "success" || k === "成功"
    ? "hsl(var(--success))"
    : "hsl(var(--destructive))";
}

/**
 * 维度 + 系列名 → CSS 色（hsl(var(--x)) 包裹形式）。未知维度回退中性灰；
 * token/risk 维度未知 key 回退中性灰；cache/calls/cost 未知 key 回退 primary。
 */
export function seriesColor(dim: Dimension, key: string): string {
  const k = key.trim().toLowerCase();
  switch (dim) {
    case "tokens":
      return TOKEN_SERIES[k] ?? NEUTRAL;
    case "cache":
      return CACHE_SERIES[k] ?? PRIMARY;
    case "risk":
      return riskColor(k);
    case "success":
      return successColor(k);
    case "calls":
    case "cost":
      return PRIMARY;
    default:
      return NEUTRAL;
  }
}
