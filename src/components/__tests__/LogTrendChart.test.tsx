import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import LogTrendChart, {
  niceCeil,
  computeTicks,
  stackSums,
  formatBucketLabel,
} from "../LogTrendChart";
import type { TimeBucket } from "../../types";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart">{children}</div>
  ),
  Area: () => <div data-testid="area" />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const baseBucket: TimeBucket = {
  bucket: 1704067200,
  calls: 10,
  input_tokens: 100,
  output_tokens: 80,
  error_count: 1,
  risk_counts: { clean: 5, info: 2, low: 2, medium: 1, high: 0, critical: 0 },
};

describe("LogTrendChart pure functions", () => {
  it("niceCeil 规整 Y 上限", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(14)).toBe(20);
    expect(niceCeil(123)).toBe(200);
    expect(niceCeil(1000)).toBe(1000);
  });

  it("computeTicks 按 bucketSecs 格式化刻度", () => {
    const hourBuckets: TimeBucket[] = Array.from({ length: 12 }, (_, i) => ({
      ...baseBucket,
      bucket: baseBucket.bucket + i * 3600,
      calls: i + 1,
    }));
    const { xLabels: hourLabels } = computeTicks(hourBuckets, 3600);
    expect(hourLabels.length).toBeLessThanOrEqual(7);
    expect(hourLabels.length).toBeGreaterThanOrEqual(2);
    expect(hourLabels[0].label).toMatch(/^\d{2}-\d{2} \d{2}:00$/);
    expect(hourLabels[hourLabels.length - 1].i).toBe(11);

    const dayBuckets: TimeBucket[] = Array.from({ length: 7 }, (_, i) => ({
      ...baseBucket,
      bucket: baseBucket.bucket + i * 86400,
      calls: i + 1,
    }));
    const { xLabels: dayLabels } = computeTicks(dayBuckets, 86400);
    expect(dayLabels[0].label).toMatch(/^\d{2}-\d{2}$/);
    expect(dayLabels[dayLabels.length - 1].i).toBe(6);

    // 单个 bucket 也应按 bucketSecs 决定格式，而非退化为小时格式
    const singleBucket: TimeBucket[] = [{ ...baseBucket, bucket: baseBucket.bucket }];
    expect(computeTicks(singleBucket, 86400).xLabels[0].label).toMatch(/^\d{2}-\d{2}$/);
    expect(computeTicks(singleBucket, 3600).xLabels[0].label).toMatch(/^\d{2}-\d{2} \d{2}:00$/);
  });

  it("formatBucketLabel 区分小时与天", () => {
    const hourTs = new Date("2024-01-01T08:00:00").getTime();
    expect(formatBucketLabel(3600, hourTs)).toBe("01-01 08:00");
    expect(formatBucketLabel(86400, hourTs)).toBe("01-01");
  });

  it("stackSums 求和各 risk", () => {
    expect(stackSums(baseBucket)).toBe(10);
    expect(stackSums({ ...baseBucket, risk_counts: {} })).toBe(0);
  });
});

describe("LogTrendChart component (Recharts)", () => {
  it("renders without crashing and shows empty state", () => {
    render(<LogTrendChart buckets={[]} dimension="calls" bucketSecs={3600} />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("calls 维度渲染 1 个 Area", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="calls" bucketSecs={3600} />);
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(screen.getAllByTestId("area")).toHaveLength(1);
  });

  it("tokens 维度渲染 2 个 Area(input/output)", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="tokens" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(2);
  });

  it("success 维度渲染 1 个 Area", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="success" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(1);
  });

  it("cache 维度渲染 2 个 Area(缓存创建/缓存命中)", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="cache" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(2);
  });

  it("cost 维度渲染 1 个 Area(费用)", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="cost" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(1);
  });

  it("risk 维度渲染 6 个 Area(stacked)", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="risk" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(6);
  });

  it("success 维度渲染绿色面积图", () => {
    render(<LogTrendChart buckets={[baseBucket]} dimension="success" bucketSecs={3600} />);
    expect(screen.getAllByTestId("area")).toHaveLength(1);
  });
});
