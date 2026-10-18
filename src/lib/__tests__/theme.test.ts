import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTheme, applyTheme, subscribeSystemTheme } from "../theme";

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
