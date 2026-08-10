import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import LogTrendChart, {
  niceCeil,
  computeTicks,
  stackSums,
  formatBucketLabel,
} from "../LogTrendChart";
import type { TimeBucket } from "../../types";

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

  it("computeTicks 稀疏取刻度", () => {
    const buckets: TimeBucket[] = Array.from({ length: 12 }, (_, i) => ({
      ...baseBucket,
      bucket: baseBucket.bucket + i * 3600,
      calls: i + 1,
    }));
    const { xLabels, yMax } = computeTicks(buckets);
    expect(yMax).toBe(20);
    expect(xLabels.length).toBeLessThanOrEqual(7);
    expect(xLabels.length).toBeGreaterThanOrEqual(2);
    expect(xLabels[0].label).toMatch(/^\d{2}-\d{2} \d{2}:00$/);
    expect(xLabels[xLabels.length - 1].i).toBe(11);
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

describe("LogTrendChart component", () => {
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("renders without crashing and shows empty state", () => {
    render(<LogTrendChart buckets={[]} dimension="calls" />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();
  });

  it("renders canvas when buckets present", () => {
    const { container } = render(<LogTrendChart buckets={[baseBucket]} dimension="calls" />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("renders canvas for tokens dimension", () => {
    const { container } = render(<LogTrendChart buckets={[baseBucket]} dimension="tokens" />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("renders canvas for success dimension", () => {
    const { container } = render(<LogTrendChart buckets={[baseBucket]} dimension="success" />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("renders canvas for risk dimension", () => {
    const { container } = render(<LogTrendChart buckets={[baseBucket]} dimension="risk" />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });
});
