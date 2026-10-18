export type ThemeMode = "light" | "dark" | "system";

/** 把三态主题解析为最终生效的主题（system 跟随系统偏好）。 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** 立即把主题应用到 <html>（挂/摘 dark 类）。 */
export function applyTheme(mode: ThemeMode): void {
  const dark = mode === "dark" || (mode === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

/** 订阅系统明暗偏好变化，返回取消订阅函数。 */
export function subscribeSystemTheme(cb: () => void): () => void {
  const mql = window.matchMedia(DARK_QUERY);
  const handler = () => cb();
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  // 旧 Safari 兼容：无 addEventListener 时退回 addListener
  mql.addListener(handler);
  return () => mql.removeListener(handler);
}
