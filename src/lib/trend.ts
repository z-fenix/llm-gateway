import type { TimeBucket } from "../types";

/// cc-switch 规则：时长 <= 24h 用小时粒度，否则用日粒度。
export function bucketSizeForRange(startEpochSecs: number, endEpochSecs: number): number {
  return endEpochSecs - startEpochSecs <= 24 * 3600 ? 3600 : 86400;
}

/// 浏览器本地时区相对 UTC 的偏移（秒，东为正）。
export function localOffsetSecs(now: Date = new Date()): number {
  return -now.getTimezoneOffset() * 60;
}

const EMPTY_RISK: Record<string, number> = {
  clean: 0,
  info: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

/// 按桶序列补全缺失的时间点（值为 0），使趋势线连续。
/// 桶边界与后端一致：((t + offset) / bucket) * bucket - offset。
/// 区间内完全没有数据时返回空（由页面展示空状态，而非造一条零线）。
export function fillBuckets(
  buckets: TimeBucket[],
  startEpochSecs: number,
  endEpochSecs: number,
  bucketSecs: number,
  tzOffsetSecs: number,
): TimeBucket[] {
  if (buckets.length === 0) {
    return [];
  }
  const byBucket = new Map(buckets.map((b) => [b.bucket, b]));
  const first =
    Math.floor((startEpochSecs + tzOffsetSecs) / bucketSecs) * bucketSecs - tzOffsetSecs;
  const out: TimeBucket[] = [];
  for (let t = first; t <= endEpochSecs; t += bucketSecs) {
    const existing = byBucket.get(t);
    if (existing) {
      out.push(existing);
    } else {
      out.push({
        bucket: t,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        error_count: 0,
        risk_counts: { ...EMPTY_RISK },
      });
    }
  }
  return out;
}
