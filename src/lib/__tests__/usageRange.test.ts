import { describe, it, expect } from "vitest";
import { resolveUsageRange, getUsageRangePresetLabel } from "../usageRange";

const FIXED_NOW = new Date(2024, 0, 15, 12, 30, 0).getTime(); // 2024-01-15 12:30 本地
const NOW_SEC = Math.floor(FIXED_NOW / 1000);

describe("resolveUsageRange", () => {
  it("today: 本地当日 0 点 → now", () => {
    const r = resolveUsageRange({ preset: "today" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2024, 0, 15, 0, 0, 0).getTime() / 1000);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("1d: now − 24h → now", () => {
    const r = resolveUsageRange({ preset: "1d" }, FIXED_NOW);
    expect(r.startDate).toBe(NOW_SEC - 24 * 3600);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("7d: 本地日界回看 6 天 → now", () => {
    const r = resolveUsageRange({ preset: "7d" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2024, 0, 9, 0, 0, 0).getTime() / 1000);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("30d: 本地日界回看 29 天", () => {
    const r = resolveUsageRange({ preset: "30d" }, FIXED_NOW);
    expect(r.startDate).toBe(new Date(2023, 11, 17, 0, 0, 0).getTime() / 1000);
  });

  it("custom 缺省 start 用 now−24h,无 endDate 用 now", () => {
    const r = resolveUsageRange({ preset: "custom" }, FIXED_NOW);
    expect(r.startDate).toBe(NOW_SEC - 24 * 3600);
    expect(r.endDate).toBe(NOW_SEC);
  });

  it("custom 指定 start/end 且 liveEndTime=false 用固定 end", () => {
    const start = new Date(2024, 0, 10, 0, 0).getTime() / 1000;
    const end = new Date(2024, 0, 12, 23, 59).getTime() / 1000;
    const r = resolveUsageRange(
      { preset: "custom", customStartDate: start, customEndDate: end, liveEndTime: false },
      FIXED_NOW
    );
    expect(r.startDate).toBe(start);
    expect(r.endDate).toBe(end);
  });

  it("custom liveEndTime=true 时 end 取 now", () => {
    const start = new Date(2024, 0, 10, 0, 0).getTime() / 1000;
    const r = resolveUsageRange(
      { preset: "custom", customStartDate: start, liveEndTime: true },
      FIXED_NOW
    );
    expect(r.endDate).toBe(NOW_SEC);
  });
});

describe("getUsageRangePresetLabel", () => {
  it("返回中文预设名", () => {
    expect(getUsageRangePresetLabel("today")).toBe("当天");
    expect(getUsageRangePresetLabel("1d")).toBe("1d");
    expect(getUsageRangePresetLabel("30d")).toBe("30d");
    expect(getUsageRangePresetLabel("custom")).toBe("日历筛选");
  });
});
