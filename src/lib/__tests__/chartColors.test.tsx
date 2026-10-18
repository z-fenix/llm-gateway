import { describe, it, expect } from "vitest";
import { seriesColor, type Dimension } from "../chartColors";

describe("chartColors.seriesColor", () => {
  it("token 维度：input→中性灰、output→primary、cache_read→info、cache_creation→warning", () => {
    expect(seriesColor("tokens", "input")).toContain("--muted-foreground");
    expect(seriesColor("tokens", "output")).toContain("--primary");
    expect(seriesColor("tokens", "cache_read")).toContain("--info");
    expect(seriesColor("tokens", "cache_creation")).toContain("--warning");
  });

  it("token 维度未知 key 回退中性灰；key 匹配大小写不敏感", () => {
    expect(seriesColor("tokens", "unknown-key")).toContain("--muted-foreground");
    expect(seriesColor("tokens", "OUTPUT")).toContain("--primary");
    expect(seriesColor("tokens", " Cache_Read ")).toContain("--info");
  });

  it("risk 维度：clean/info/low/medium 按语义色", () => {
    expect(seriesColor("risk", "clean")).toContain("--muted-foreground");
    expect(seriesColor("risk", "info")).toContain("--info");
    expect(seriesColor("risk", "low")).toContain("--success");
    expect(seriesColor("risk", "medium")).toContain("--warning");
  });

  it("risk 维度：critical→destructive、high 用 color-mix 降 20% 不透明度", () => {
    expect(seriesColor("risk", "critical")).toContain("--destructive");
    expect(seriesColor("risk", "high")).toContain("--destructive");
    expect(seriesColor("risk", "high")).toContain("color-mix");
  });

  it("risk 维度未知 key 回退中性灰", () => {
    expect(seriesColor("risk", "unknown-key")).toContain("--muted-foreground");
  });

  it("非语义维度（calls/cost）任意 key 用 primary", () => {
    expect(seriesColor("calls", "calls")).toContain("--primary");
    expect(seriesColor("calls", "main")).toContain("--primary");
    expect(seriesColor("cost", "cost")).toContain("--primary");
  });

  it("cache 维度：cache_read→info、cache_creation→warning、其余主系列→primary", () => {
    expect(seriesColor("cache", "cache_read")).toContain("--info");
    expect(seriesColor("cache", "cache_creation")).toContain("--warning");
    expect(seriesColor("cache", "main")).toContain("--primary");
  });

  it("成功率维度：成功→success、其余（失败）→destructive", () => {
    expect(seriesColor("success", "success")).toContain("--success");
    expect(seriesColor("success", "成功")).toContain("--success");
    expect(seriesColor("success", "error")).toContain("--destructive");
  });

  it("未知维度回退中性灰", () => {
    expect(seriesColor("nope" as Dimension, "anything")).toContain(
      "--muted-foreground"
    );
  });
});
