import { load } from "@tauri-apps/plugin-store";

export type ThemeMode = "light" | "dark" | "system";

const STORE_FILE = "store.bin";
const THEME_KEY = "theme";

function validThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

type Store = Awaited<ReturnType<typeof load>>;

// plugin-store 的 API 全部异步，而 loadThemeMode 是同步接口，
// 故用模块加载时的一次性异步镜像把 store 值同步进内存/localStorage
let cachedStore: Store | null = null;
let cachedMode: ThemeMode | null = null;

function loadFromLocalStorage(): ThemeMode | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return validThemeMode(v) ? v : null;
  } catch {
    return null;
  }
}

function mirrorToLocalStorage(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // localStorage 不可用则放弃镜像，store 仍是主存储
  }
}

async function ensureStore(): Promise<Store | null> {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = await load(STORE_FILE, { autoSave: false });
    const v: unknown = await cachedStore.get(THEME_KEY);
    if (validThemeMode(v)) {
      cachedMode = v;
      mirrorToLocalStorage(v);
    }
    return cachedStore;
  } catch {
    return null; // store 不可用（权限/环境），后续走 localStorage
  }
}

// 模块加载时预热：把 store 中的主题镜像到内存，供同步的 loadThemeMode 读取
if (typeof window !== "undefined") {
  void ensureStore();
}

/**
 * 同步读取已持久化的主题模式。
 * 优先返回 store 镜像值，其次 localStorage，两者皆无（或值非法）时返回 null。
 */
export function loadThemeMode(): ThemeMode | null {
  if (cachedMode !== null) return cachedMode;
  return loadFromLocalStorage();
}

/** 持久化主题模式：优先写 plugin-store（store.bin），任何异常降级 localStorage。 */
export async function saveThemeMode(m: ThemeMode): Promise<void> {
  const store = await ensureStore();
  if (store) {
    try {
      await store.set(THEME_KEY, m);
      await store.save();
      cachedMode = m;
      mirrorToLocalStorage(m); // 双写兜底：store 损坏时 localStorage 仍有最近值
      return;
    } catch {
      // 落入 localStorage 降级
    }
  }
  mirrorToLocalStorage(m);
}

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
