import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
