import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import RefreshControls from "../RefreshControls";
import { useRefreshInterval, REFRESH_OPTIONS } from "../../lib/useRefreshInterval";

describe("useRefreshInterval", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("默认关闭并持久化到 localStorage", () => {
    let secs!: number;
    function Probe() {
      [secs] = useRefreshInterval("test-refresh");
      return null;
    }
    render(<Probe />);
    expect(secs).toBe(0);
    expect(window.localStorage.getItem("test-refresh")).toBeNull();
  });

  it("读取已保存的间隔", () => {
    window.localStorage.setItem("test-refresh", "30");
    let secs!: number;
    function Probe() {
      [secs] = useRefreshInterval("test-refresh");
      return null;
    }
    render(<Probe />);
    expect(secs).toBe(30);
  });

  it("变更后写回 localStorage", () => {
    let set!: (s: number) => void;
    function Probe() {
      [, set] = useRefreshInterval("test-refresh");
      return null;
    }
    render(<Probe />);
    set(10);
    expect(window.localStorage.getItem("test-refresh")).toBe("10");
  });
});

describe("RefreshControls", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("渲染刷新按钮与间隔选项，点击刷新触发 onRefresh", () => {
    const onRefresh = vi.fn();
    render(
      <RefreshControls secs={0} onSecsChange={() => {}} onRefresh={onRefresh} />
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalled();
    expect(REFRESH_OPTIONS.length).toBe(5);
  });

  it("选择间隔触发 onSecsChange", async () => {
    const onSecsChange = vi.fn();
    render(
      <RefreshControls secs={0} onSecsChange={onSecsChange} onRefresh={() => {}} />
    );
    fireEvent.click(screen.getByRole("combobox", { name: "自动刷新间隔" }));
    fireEvent.click(await screen.findByRole("option", { name: "10s" }));
    await waitFor(() => expect(onSecsChange).toHaveBeenCalledWith(10));
  });
});
