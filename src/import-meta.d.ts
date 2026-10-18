// import.meta.glob 的最小类型声明：项目未装 @types/node（不用 node:fs），
// 也不引入 vite/client（避免与 __tests__/raw.d.ts 的 `*?raw` 声明重复冲突）。
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: string; import: string; eager: boolean },
  ): Record<string, string>;
}
