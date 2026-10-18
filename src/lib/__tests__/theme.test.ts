import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { resolveTheme, applyTheme, subscribeSystemTheme } from "../theme";

// plugin-store 句柄可控的 mock：默认不可用（load 直接拒绝），由各用例自行注入
const storeState = vi.hoisted(() => ({
  loadImpl: null as null | ((path: string, options?: unknown) => Promise<unknown>),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: (path: string, options?: unknown) =>
    storeState.loadImpl
      ? storeState.loadImpl(path, options)
      : Promise.reject(new Error("plugin-store 不可用")),
}));

beforeEach(() => {
  // jsdom 未实现 matchMedia；用假对象，事件直接桥接到 window 以便 dispatchEvent 触发
  const fakeMql = {
    matches: false,
    addEventListener: (_: string, cb: EventListener) => window.addEventListener("change", cb),
    removeEventListener: (_: string, cb: EventListener) => window.removeEventListener("change", cb),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => fakeMql));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("resolveTheme", () => {
  it.each([
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ] as const)("%s + systemDark=%s → %s", (mode, sysDark, want) => {
    expect(resolveTheme(mode, sysDark)).toBe(want);
  });
});

describe("applyTheme", () => {
  it("mounts and unmounts the dark class", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system mode with dark preference mounts the dark class", () => {
    const fakeMql = {
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    vi.stubGlobal("matchMedia", vi.fn(() => fakeMql));
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("subscribeSystemTheme", () => {
  it("invokes callback on change and unsubscribes", () => {
    const cb = vi.fn();
    const unsub = subscribeSystemTheme(cb);
    window.dispatchEvent(new Event("change")); // matchMedia mock provides this
    expect(cb).toHaveBeenCalled();
    unsub();
  });

  it("stops invoking after unsubscribe", () => {
    const cb = vi.fn();
    const unsub = subscribeSystemTheme(cb);
    unsub();
    window.dispatchEvent(new Event("change"));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("主题持久化", () => {
  // loadThemeMode 为同步接口，store 读取靠模块加载时的异步镜像完成，
  // 故持久化用例用 vi.resetModules + 动态 import 获得全新模块状态
  function importFresh(): Promise<typeof import("../theme")> {
    return import("../theme");
  }

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    localStorage.clear();
    storeState.loadImpl = null;
    vi.resetModules();
  });

  afterEach(() => {
    storeState.loadImpl = null;
  });

  describe("saveThemeMode", () => {
    it("store 可用时写入 store（key theme）并落盘", async () => {
      const store = { get: vi.fn(), set: vi.fn(), save: vi.fn() };
      storeState.loadImpl = vi.fn().mockResolvedValue(store);
      const { saveThemeMode } = await importFresh();

      await saveThemeMode("dark");

      expect(store.set).toHaveBeenCalledWith("theme", "dark");
      expect(store.save).toHaveBeenCalled();
      expect(storeState.loadImpl).toHaveBeenCalledWith("store.bin", expect.anything());
    });

    it("store 抛错时降级写入 localStorage", async () => {
      storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
      const { saveThemeMode } = await importFresh();

      await saveThemeMode("light");

      expect(localStorage.getItem("theme")).toBe("light");
    });

    it("store.set 抛错时同样降级写入 localStorage", async () => {
      const store = { get: vi.fn(), set: vi.fn().mockRejectedValue(new Error("set 失败")), save: vi.fn() };
      storeState.loadImpl = vi.fn().mockResolvedValue(store);
      const { saveThemeMode } = await importFresh();

      await saveThemeMode("system");

      expect(localStorage.getItem("theme")).toBe("system");
    });
  });

  describe("loadThemeMode", () => {
    it("优先读取 store 中的值", async () => {
      const store = { get: vi.fn().mockResolvedValue("dark"), set: vi.fn(), save: vi.fn() };
      storeState.loadImpl = vi.fn().mockResolvedValue(store);
      const { loadThemeMode } = await importFresh();
      await flushMicrotasks(); // 等待模块启动时的异步镜像完成

      expect(loadThemeMode()).toBe("dark");
    });

    it("store 不可用时读 localStorage", async () => {
      storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
      localStorage.setItem("theme", "light");
      const { loadThemeMode } = await importFresh();
      await flushMicrotasks();

      expect(loadThemeMode()).toBe("light");
    });

    it("两者皆无值时返回 null", async () => {
      storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
      const { loadThemeMode } = await importFresh();
      await flushMicrotasks();

      expect(loadThemeMode()).toBeNull();
    });

    it("忽略非法存储值", async () => {
      const store = { get: vi.fn().mockResolvedValue("blue"), set: vi.fn(), save: vi.fn() };
      storeState.loadImpl = vi.fn().mockResolvedValue(store);
      const { loadThemeMode } = await importFresh();
      await flushMicrotasks();

      expect(loadThemeMode()).toBeNull();
    });
  });
});

describe("useTheme", () => {
  // useTheme 读取模块内缓存（cachedMode/cachedStore），每个用例用全新模块实例隔离
  let useTheme: typeof import("../theme").useTheme;

  beforeEach(async () => {
    localStorage.clear();
    storeState.loadImpl = null;
    vi.resetModules();
    ({ useTheme } = await import("../theme"));
  });

  it("初始 mode 取自 localStorage，setMode('dark') 挂载 dark 类并写入 store", async () => {
    const store = { get: vi.fn(), set: vi.fn(), save: vi.fn() };
    storeState.loadImpl = vi.fn().mockResolvedValue(store);
    localStorage.setItem("theme", "system");
    ({ useTheme } = await import("../theme"));

    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");

    await act(async () => {
      result.current.setMode("dark");
    });

    expect(result.current.mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(store.set).toHaveBeenCalledWith("theme", "dark");
    expect(store.save).toHaveBeenCalled();
  });

  it("无持久化值时初始 mode 为 system，setMode('light') 摘除 dark 类并降级 localStorage", async () => {
    storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
    ({ useTheme } = await import("../theme"));
    document.documentElement.classList.add("dark");

    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe("system");

    await act(async () => {
      result.current.setMode("light");
    });

    expect(result.current.mode).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await waitFor(() => expect(localStorage.getItem("theme")).toBe("light"));
  });
});

describe("initTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    storeState.loadImpl = null;
    vi.resetModules();
  });

  it("应用已持久化的主题模式（localStorage: dark）", async () => {
    storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
    localStorage.setItem("theme", "dark");
    const { initTheme } = await import("../theme");

    initTheme();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("无持久化值时按 system 应用", async () => {
    storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
    const { initTheme } = await import("../theme");

    initTheme();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("store 镜像异步解析后重新应用持久化主题，修正首帧错误默认", async () => {
    const store = { get: vi.fn().mockResolvedValue("dark"), set: vi.fn(), save: vi.fn() };
    // load 返回手动控制的 deferred：镜像在 release 前保持未决，模拟首帧窗口
    let release!: (store: unknown) => void;
    storeState.loadImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    // localStorage 故意留空：同步阶段 loadThemeMode 返回 null，initTheme 先按 system 应用
    const { initTheme, ensureThemeReady } = await import("../theme");
    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    release(store);
    await ensureThemeReady();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system 模式下系统明暗偏好变化时重新应用", async () => {
    storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
    const listeners: Array<() => void> = [];
    let matches = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, cb: () => void) => {
          listeners.push(cb);
        },
        removeEventListener: () => {},
      }))
    );
    localStorage.setItem("theme", "system");
    const { initTheme } = await import("../theme");

    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    matches = true;
    listeners.forEach((cb) => cb());
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    matches = false;
    listeners.forEach((cb) => cb());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("非 system 模式下系统偏好变化不覆盖用户选择", async () => {
    storeState.loadImpl = vi.fn().mockRejectedValue(new Error("store 打不开"));
    const listeners: Array<() => void> = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true, // 系统为深色，但用户显式选了浅色
        addEventListener: (_: string, cb: () => void) => {
          listeners.push(cb);
        },
        removeEventListener: () => {},
      }))
    );
    localStorage.setItem("theme", "light");
    const { initTheme } = await import("../theme");

    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    listeners.forEach((cb) => cb()); // 系统偏好再次派发变化事件

    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
