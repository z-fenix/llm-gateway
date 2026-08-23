import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { UsageDateRangePicker } from "../UsageDateRangePicker";

describe("UsageDateRangePicker", () => {
  it("触发器显示当前预设标签", () => {
    render(
      <UsageDateRangePicker selection={{ preset: "7d" }} onApply={() => {}} triggerLabel="7d" />
    );
    expect(screen.getByRole("button", { name: /7d/ })).toBeInTheDocument();
  });

  it("点击预设按钮立即应用所选预设", async () => {
    const onApply = vi.fn();
    render(
      <UsageDateRangePicker selection={{ preset: "7d" }} onApply={onApply} triggerLabel="7d" />
    );
    fireEvent.click(screen.getByRole("button", { name: /7d/ }));
    fireEvent.click(await screen.findByRole("button", { name: "1d" }));
    expect(onApply).toHaveBeenCalledWith({ preset: "1d" });
  });

  it("开始时间晚于结束时间时,确定被拒绝并显示错误", async () => {
    const onApply = vi.fn();
    render(
      <UsageDateRangePicker
        selection={{ preset: "custom", customStartDate: 1700003600, customEndDate: 1700000000 }}
        onApply={onApply}
        triggerLabel="日历筛选"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /日历筛选/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确定" }));
    expect(await screen.findByText("开始时间不能晚于结束时间")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("custom 模式显示 live-end 复选框", async () => {
    render(
      <UsageDateRangePicker
        selection={{ preset: "custom", customStartDate: 1700000000, customEndDate: 1700003600 }}
        onApply={() => {}}
        triggerLabel="日历筛选"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /日历筛选/ }));
    expect(await screen.findByText("结束时间跟随当前时刻")).toBeInTheDocument();
  });
});
