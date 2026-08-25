import { describe, it, expect } from "vitest";
import { bucketSizeForRange, fillBuckets, localOffsetSecs } from "../trend";
import type { TimeBucket } from "../../types";

describe("trend helpers", () => {
  it("bucketSizeForRange 按 24h 阈值选择粒度", () => {
    expect(bucketSizeForRange(0, 24 * 3600)).toBe(3600);
    expect(bucketSizeForRange(0, 24 * 3600 + 1)).toBe(86400);
    expect(bucketSizeForRange(0, 7 * 86400)).toBe(86400);
  });

  it("localOffsetSecs 返回本地时区相对 UTC 偏移", () => {
    // UTC+8 → 480 分钟西 → offset = 480*60 = 28800
    const utc8 = new Date("2026-01-01T00:00:00Z");
    expect(localOffsetSecs(utc8)).toBe(-utc8.getTimezoneOffset() * 60);
  });

  it("fillBuckets 补齐缺失时间点且保留已有数据", () => {
    const off = 28800;
    const bs = 86400;
    // 本地对齐后的桶：[-28800, 57600]
    const buckets: TimeBucket[] = [
      {
        bucket: -28800,
        calls: 3,
        input_tokens: 10,
        output_tokens: 5,
        error_count: 1,
        risk_counts: { clean: 2, info: 0, low: 1, medium: 0, high: 0, critical: 0 },
      },
    ];

    const filled = fillBuckets(buckets, 0, 90000, bs, off);
    expect(filled).toHaveLength(2);
    expect(filled[0].bucket).toBe(-28800);
    expect(filled[0].calls).toBe(3);
    expect(filled[1].bucket).toBe(57600);
    expect(filled[1].calls).toBe(0);
    expect(filled[1].error_count).toBe(0);
    expect(filled[1].risk_counts).toEqual({
      clean: 0,
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    });
  });

  it("fillBuckets 空输入返回空（交由页面展示空状态）", () => {
    const off = 28800;
    const bs = 3600;
    const filled = fillBuckets([], 0, 7200, bs, off);
    expect(filled).toEqual([]);
  });

  it("fillBuckets 空桶补全缓存/成本字段零值", () => {
    const off = 28800;
    const bs = 86400;
    const buckets: TimeBucket[] = [
      {
        bucket: -28800,
        calls: 1,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 7,
        cache_creation_tokens: 3,
        cost: 0.0012,
        error_count: 0,
        risk_counts: { clean: 1, info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      },
    ];
    const filled = fillBuckets(buckets, 0, 90000, bs, off);
    expect(filled).toHaveLength(2);
    // 已有桶原样保留
    expect(filled[0].cache_read_tokens).toBe(7);
    expect(filled[0].cache_creation_tokens).toBe(3);
    expect(filled[0].cost).toBe(0.0012);
    // 空桶补零
    expect(filled[1].cache_read_tokens).toBe(0);
    expect(filled[1].cache_creation_tokens).toBe(0);
    expect(filled[1].cost).toBe(0);
  });
});
