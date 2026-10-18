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

// ts 源码 glob（events/tagStyles 等常量模块守卫用；.tsx 之外的另一半源码树）
const tsSources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// 调色板色类：text-/bg-/border-/ring-/fill-/stroke- + 具体色名 + 数字档位
const PALETTE =
  /(text|bg|border|ring|fill|stroke)-(red|green|emerald|amber|orange|purple|violet|blue|sky|cyan|pink|rose|lime|yellow|teal|indigo|fuchsia|slate|gray|zinc|neutral|stone)-\d+/;
// dark: 死类：真暗色来自令牌，不允许任何 dark: 工具类
const DARK_UTILITY = /[\s"']dark:/;
// 渐变类：统一禁止任何方向的 bg-gradient-to-*
const GRADIENT = /bg-gradient-to-/;

// NEUTRAL_TAG 的特征子串：共享前必须只存在于 tagStyles.ts
const NEUTRAL_TAG_SNIPPET =
  "rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]";

// ts + tsx 合并源码（守卫测试文件自身豁免：断言字符串会合法引用被守卫的字面量）
const allSources: Record<string, string> = { ...tsSources, ...sources };
const guardFiles = (map: Record<string, string>) =>
  Object.entries(map).filter(
    ([path]) => !path.includes("__tests__") && !path.includes(".test.")
  );

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

describe("guard: gateway-refresh 常量与 NEUTRAL_TAG 共享", () => {
  it('"gateway-refresh" 字面量只出现在 src/lib/events.ts', () => {
    const offenders = guardFiles(allSources)
      .filter(([, src]) => src.includes("gateway-refresh"))
      .map(([path]) => path)
      .sort();
    expect(offenders).toEqual(["./lib/events.ts"]);
  });

  it("tagStyles.ts 存在且 Channels/Sessions 改为导入 NEUTRAL_TAG", () => {
    expect(tsSources["./lib/tagStyles.ts"]).toBeDefined();
    expect(sources["./pages/ChannelsPage.tsx"]).toMatch(
      /from ["']\.\.\/lib\/tagStyles["']/
    );
    expect(sources["./pages/SessionsPage.tsx"]).toMatch(
      /from ["']\.\.\/lib\/tagStyles["']/
    );
  });

  it("NEUTRAL_TAG 类串不再在页面里重复内联", () => {
    const offenders = guardFiles(allSources)
      .filter(([path, src]) => src.includes(NEUTRAL_TAG_SNIPPET))
      .map(([path]) => path)
      .sort();
    expect(offenders).toEqual(["./lib/tagStyles.ts"]);
  });

  it("McpServers 状态点改为 StatusBadge", () => {
    const src = sources["./pages/McpServersPage.tsx"];
    expect(src).toMatch(/from ["']\.\.\/components\/StatusBadge["']/);
    expect(src).not.toContain("h-1.5 w-1.5 rounded-full");
  });
});
