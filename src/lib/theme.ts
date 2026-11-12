import { useCallback, useEffect, useState } from "react";
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
let cachedMode: ThemeMode | null = null;
// 在途的 store 打开请求做记忆化，避免并发调用重复发起 IPC load
let storePromise: Promise<Store | null> | null = null;

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

function openStore(): Promise<Store | null> {
  return (async () => {
    try {
      const store = await load(STORE_FILE, { autoSave: false });
      const v: unknown = await store.get(THEME_KEY);
      // 仅在尚无缓存值时回填镜像，避免覆盖用户已交互设置的模式
      if (validThemeMode(v) && cachedMode === null) {
        cachedMode = v;
        mirrorToLocalStorage(v);
      }
      return store;
    } catch {
      return null; // store 不可用（权限/环境），后续走 localStorage
    }
  })();
}

async function ensureStore(): Promise<Store | null> {
  if (!storePromise) {
    storePromise = openStore().then((store) => {
      if (!store) storePromise = null; // 失败不缓存，允许后续重试
      return store;
    });
  }
  return storePromise;
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

/** 订阅系统明暗偏好变化，返回取消订阅函数。环境不支持 matchMedia 时返回空操作。 */
export function subscribeSystemTheme(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(DARK_QUERY);
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  }
  // 旧 Safari 兼容：无 addEventListener 时退回 addListener
  mql.addListener(cb);
  return () => mql.removeListener(cb);
}

/**
 * 应用启动时调用一次：按已持久化的模式应用主题，并订阅系统明暗变化。
 * system 模式（含未持久化的默认值）下偏好变化会重新应用；其他模式不覆盖用户选择。
 */
export function initTheme(): void {
  applyTheme(loadThemeMode() ?? "system");
  void ensureThemeReady();
  subscribeSystemTheme(() => {
    if ((loadThemeMode() ?? "system") === "system") {
      applyTheme("system");
    }
  });
}

/**
 * 等待 plugin-store 镜像解析完成并重新应用一次主题。
 * 首帧时镜像可能尚未就绪（loadThemeMode 返回 null），持久化的真实值
 * 解析后由此补上，错误的默认主题窗口只持续约一帧。
 */
export async function ensureThemeReady(): Promise<void> {
  await ensureStore();
  const resolved = loadThemeMode() ?? "system";
  applyTheme(resolved);
  notifyThemeChange(resolved);
}

// 跨源主题变更注册表：模块内任何改变生效主题的入口（ensureThemeReady 镜像解析、
// setMode 持久化完成）都通过它广播，供其他 useTheme 实例等订阅方对齐自身状态
type ThemeChangeCallback = (mode: ThemeMode) => void;
const themeChangeListeners = new Set<ThemeChangeCallback>();

/** 订阅主题模式变更，返回退订函数。 */
export function subscribeThemeChange(cb: (mode: ThemeMode) => void): () => void {
  themeChangeListeners.add(cb);
  return () => {
    themeChangeListeners.delete(cb);
  };
}

function notifyThemeChange(mode: ThemeMode): void {
  themeChangeListeners.forEach((cb) => cb(mode));
}

/** React hook：当前主题模式与切换函数（立即应用并持久化）。 */
export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeMode() ?? "system");
  useEffect(() => {
    // 跨源变更才对齐状态：自身 setMode 触发的通知是同值，函数式更新直接跳过
    return subscribeThemeChange((next) => {
      setModeState((prev) => (prev === next ? prev : next));
    });
  }, []);
  const setMode = useCallback((next: ThemeMode) => {
    applyTheme(next);
    // 通知放在 save 解析后：镜像（cachedMode/localStorage）已更新，
    // 其他实例收到通知时 loadThemeMode 能读到一致的新值
    void saveThemeMode(next).then(() => notifyThemeChange(next));
    setModeState(next);
  }, []);
  return { mode, setMode };
}
