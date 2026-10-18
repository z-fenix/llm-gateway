import { describe, it, expect } from "vitest";

// 硬编码色守卫：Vite ?raw glob 在编译期把整个 src 树的 tsx 源码读成字符串，
// 等价于计划里的 node:fs walk（项目未装 @types/node，故用 glob 方案）。
const sources = import.meta.glob("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// 豁免：ui/ 原语源码保持设计外代码不动（计划约束）；
// __tests__ 里的断言字符串会合法引用被禁类名（如回归测试钉住 "bg-gradient-to-b" 不出现）。
const exempt = (path: string) =>
  path.startsWith("./components/ui/") || path.includes("__tests__");

// 调色板色类：text-/bg-/border-/ring-/fill-/stroke- + 具体色名 + 数字档位
const PALETTE =
  /(text|bg|border|ring|fill|stroke)-(red|green|emerald|amber|orange|purple|violet|blue|sky|cyan|pink|rose|lime|yellow|teal|indigo|fuchsia|slate|gray|zinc|neutral|stone)-\d+/;
// dark: 死类：真暗色来自令牌，不允许任何 dark: 工具类
const DARK_UTILITY = /[\s"']dark:/;
// 渐变类：统一禁止任何方向的 bg-gradient-to-*
const GRADIENT = /bg-gradient-to-/;

describe("tokens guard: 全项目零硬编码调色板色", () => {
  const files = Object.entries(sources).filter(([path]) => !exempt(path));

  it("glob 收集到 src 下全部非豁免 tsx 源码", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("无硬编码调色板色类", () => {
    const offenders = files
      .filter(([, src]) => PALETTE.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("无 dark: 死类（暗色来自令牌）", () => {
    const offenders = files
      .filter(([, src]) => DARK_UTILITY.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("无 bg-gradient-to-* 渐变类", () => {
    const offenders = files
      .filter(([, src]) => GRADIENT.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
