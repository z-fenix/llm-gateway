import { describe, it, expect } from "vitest";
import { seriesColor, type Dimension } from "../chartColors";

// 令牌为 HSL 三元组，系列色必须是 hsl(var(--x)) 包裹形式（裸 var(--x) 不是合法 CSS 色）
describe("chartColors.seriesColor", () => {
  it("token 维度：input→中性灰、output→primary、cache_read→info、cache_creation→warning", () => {
    expect(seriesColor("tokens", "input")).toBe("hsl(var(--muted-foreground))");
    expect(seriesColor("tokens", "output")).toBe("hsl(var(--primary))");
    expect(seriesColor("tokens", "cache_read")).toBe("hsl(var(--info))");
    expect(seriesColor("tokens", "cache_creation")).toBe("hsl(var(--warning))");
  });

  it("token 维度未知 key 回退中性灰；key 匹配大小写不敏感", () => {
    expect(seriesColor("tokens", "unknown-key")).toBe("hsl(var(--muted-foreground))");
    expect(seriesColor("tokens", "OUTPUT")).toBe("hsl(var(--primary))");
    expect(seriesColor("tokens", " Cache_Read ")).toBe("hsl(var(--info))");
  });

  it("risk 维度：clean/info/low/medium 按语义色", () => {
    expect(seriesColor("risk", "clean")).toBe("hsl(var(--muted-foreground))");
    expect(seriesColor("risk", "info")).toBe("hsl(var(--info))");
    expect(seriesColor("risk", "low")).toBe("hsl(var(--success))");
    expect(seriesColor("risk", "medium")).toBe("hsl(var(--warning))");
  });

  it("risk 维度：critical→destructive、high 用 color-mix 降 20% 不透明度", () => {
    expect(seriesColor("risk", "critical")).toBe("hsl(var(--destructive))");
    expect(seriesColor("risk", "high")).toBe(
      "color-mix(in srgb, hsl(var(--destructive)) 80%, transparent)"
    );
  });

  it("risk 维度未知 key 回退中性灰", () => {
    expect(seriesColor("risk", "unknown-key")).toBe("hsl(var(--muted-foreground))");
  });

  it("非语义维度（calls/cost）任意 key 用 primary", () => {
    expect(seriesColor("calls", "calls")).toBe("hsl(var(--primary))");
    expect(seriesColor("calls", "main")).toBe("hsl(var(--primary))");
    expect(seriesColor("cost", "cost")).toBe("hsl(var(--primary))");
  });

  it("cache 维度：cache_read→info、cache_creation→warning、其余主系列→primary", () => {
    expect(seriesColor("cache", "cache_read")).toBe("hsl(var(--info))");
    expect(seriesColor("cache", "cache_creation")).toBe("hsl(var(--warning))");
    expect(seriesColor("cache", "main")).toBe("hsl(var(--primary))");
  });

  it("成功率维度：成功→success、其余（失败）→destructive", () => {
    expect(seriesColor("success", "success")).toBe("hsl(var(--success))");
    expect(seriesColor("success", "成功")).toBe("hsl(var(--success))");
    expect(seriesColor("success", "error")).toBe("hsl(var(--destructive))");
  });

  it("未知维度回退中性灰", () => {
    expect(seriesColor("nope" as Dimension, "anything")).toBe(
      "hsl(var(--muted-foreground))"
    );
  });
});
