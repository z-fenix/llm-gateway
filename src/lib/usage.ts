/// 使用统计相关的纯函数工具（缓存命中率、成本格式化、模型名归一化）。
/// 独立成模块便于单测，供 Dashboard/Logs/趋势图/定价表单复用。

/**
 * 缓存命中率（百分比，0-100）。
 * 命中率 = cache_read / (input + cache_creation + cache_read)，0 兜底。
 * 说明：Stats/LogStats 6a 未提供直接命中率字段，故由原始 token 聚合计算。
 */
export function cacheHitRatePercent(input: number, cacheRead: number, cacheCreation: number): number {
  const denom = input + cacheCreation + cacheRead;
  if (denom <= 0) return 0;
  return (cacheRead / denom) * 100;
}

/**
 * 真实消耗 Tokens = fresh_input + output + cache_creation + cache_read。
 * 说明：Stats 未提供 fresh_input 字段，用 input 近似（缓存 token 在 input 与 cache 两处
 * 各计一次，反映含缓存写入/命中的总吞吐量）。若后端补 fresh_input 可改用该字段。
 */
export function realTokens(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number
): number {
  return input + output + cacheRead + cacheCreation;
}

/** USD 小数值格式化（卡片/表格），如 $0 / $0.000123 / $1.2345。 */
export function formatUsd(cost?: number | null): string {
  if (cost === undefined || cost === null || !Number.isFinite(cost) || cost === 0) {
    return "$0";
  }
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

/** USD 坐标轴/紧凑格式化（趋势图 y 轴），如 0 / $0.0001 / $0.001 / $1.23。 */
export function formatUsdAxis(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v < 0.001) return `$${v.toFixed(5)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * 归一化模型名，与后端 `commands::pricing::normalize_model` 保持一致：
 * 小写/trim、去第一个 `/` 之前的前缀、去 `:` 后缀、`@`→`-`。
 * 定价按 normalize(upstream_model) 匹配，保存前必须归一化避免「成本恒为 0」的静默错误。
 */
export function normalizeModelId(id: string): string {
  const lower = id.trim().toLowerCase();
  const afterSlash = lower.includes("/") ? lower.slice(lower.indexOf("/") + 1) : lower;
  const afterColon = afterSlash.split(":")[0];
  return afterColon.trim().replace(/@/g, "-");
}
