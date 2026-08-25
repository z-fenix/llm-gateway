import { describe, it, expect } from "vitest";
import {
  cacheHitRatePercent,
  formatUsd,
  formatUsdAxis,
  normalizeModelId,
  realTokens,
} from "../usage";

describe("cacheHitRatePercent", () => {
  it("命中率 = cache_read/(input+cache_creation+cache_read)", () => {
    // 50 / (100 + 50 + 50) = 25%
    expect(cacheHitRatePercent(100, 50, 50)).toBeCloseTo(25);
    // 全命中: 100 / (0 + 0 + 100) = 100%
    expect(cacheHitRatePercent(0, 100, 0)).toBe(100);
    // 全创建无命中: 0
    expect(cacheHitRatePercent(0, 0, 100)).toBe(0);
  });

  it("分母为 0 时兜底返回 0", () => {
    expect(cacheHitRatePercent(0, 0, 0)).toBe(0);
    expect(cacheHitRatePercent(0, 0, 0)).toBe(0);
  });
});

describe("realTokens", () => {
  it("真实消耗 = input + output + cache_creation + cache_read", () => {
    // Stats 未提供 fresh_input，用 input 近似（缓存 token 两处各计一次）
    expect(realTokens(100, 50, 20, 10)).toBe(180);
    expect(realTokens(0, 0, 0, 0)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("零/空/非法均显示 $0", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(undefined)).toBe("$0");
    expect(formatUsd(null)).toBe("$0");
  });

  it("小数值保留 6 位小数", () => {
    expect(formatUsd(0.000123)).toBe("$0.000123");
    expect(formatUsd(0.001)).toBe("$0.001000");
  });

  it("较大值保留 4 位小数", () => {
    expect(formatUsd(1.23456)).toBe("$1.2346");
    expect(formatUsd(123.456)).toBe("$123.4560");
  });
});

describe("formatUsdAxis", () => {
  it("紧凑缩写 y 轴刻度", () => {
    expect(formatUsdAxis(0)).toBe("0");
    expect(formatUsdAxis(0.00012)).toBe("$0.00012");
    expect(formatUsdAxis(0.001)).toBe("$0.001");
    expect(formatUsdAxis(0.5)).toBe("$0.500");
    expect(formatUsdAxis(1.234)).toBe("$1.23");
  });
});

describe("normalizeModelId（与后端 normalize_model 对齐）", () => {
  it("小写/trim", () => {
    expect(normalizeModelId("Claude-Sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(normalizeModelId("  Gpt-4o  ")).toBe("gpt-4o");
  });

  it("去第一个 / 之前的前缀", () => {
    expect(normalizeModelId("openrouter/anthropic/claude-sonnet-4.5:free")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
    expect(normalizeModelId("azure/deployment/gpt-4o")).toBe("deployment/gpt-4o");
    expect(normalizeModelId("models/gemini-2.0-flash")).toBe("gemini-2.0-flash");
  });

  it("去 : 后缀", () => {
    expect(normalizeModelId("claude-sonnet-4.5:free")).toBe("claude-sonnet-4.5");
    expect(normalizeModelId("gpt-4o:beta")).toBe("gpt-4o");
  });

  it("@ 替换为 -", () => {
    expect(normalizeModelId("gpt-4o@2024-05-13")).toBe("gpt-4o-2024-05-13");
  });

  it("空串保持为空", () => {
    expect(normalizeModelId("")).toBe("");
    expect(normalizeModelId("   ")).toBe("");
  });
});
