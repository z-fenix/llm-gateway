export type Semantic = "success" | "warning" | "danger" | "info" | "neutral";

/**
 * HTTP 状态码 → 语义色。
 * 2xx → success；429 → warning；其余 4xx / 5xx → danger；其他（3xx、0 等）→ neutral。
 */
export function httpStatusSemantic(code: number): Semantic {
  if (code >= 200 && code < 300) return "success";
  if (code === 429) return "warning";
  if ((code >= 400 && code < 500) || (code >= 500 && code < 600)) return "danger";
  return "neutral";
}

/**
 * 安全风险等级（大小写不敏感）→ 语义色。
 * clean → neutral；info → info；low → success；medium → warning；
 * high / critical → danger；未知值 → neutral。
 */
export function riskSemantic(level: string): Semantic {
  switch (level.trim().toLowerCase()) {
    case "clean":
      return "neutral";
    case "info":
      return "info";
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
    case "critical":
      return "danger";
    default:
      return "neutral";
  }
}
