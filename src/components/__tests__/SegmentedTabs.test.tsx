import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SegmentedTabs } from "../SegmentedTabs";

type Option = "all" | "success" | "failed";

function ControlledTabs({
  onChange,
  value,
}: {
  value: Option;
  onChange: (v: Option) => void;
}) {
  return (
    <SegmentedTabs<Option>
      value={value}
      onChange={onChange}
      options={[
        { value: "all", label: "全部" },
        { value: "success", label: "成功" },
        { value: "failed", label: "失败" },
      ]}
      ariaLabel="日志筛选"
    />
  );
}

function Harness() {
  const [value, setValue] = useState<Option>("all");
  return <ControlledTabs value={value} onChange={setValue} />;
}

describe("SegmentedTabs 结构与受控切换", () => {
  it("容器为 role=tablist，选项为 role=tab，ariaLabel 落在容器上", () => {
    render(<ControlledTabs value="all" onChange={vi.fn()} />);
    const tablist = screen.getByRole("tablist", { name: "日志筛选" });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("aria-selected 跟随受控 value", () => {
    render(<ControlledTabs value="success" onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "成功" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("tab", { name: "失败" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("选中项使用左 2px primary 竖条 + bg-primary/10，未选中为 muted 文字", () => {
    render(<ControlledTabs value="all" onChange={vi.fn()} />);
    const selected = screen.getByRole("tab", { name: "全部" });
    expect(selected).toHaveClass("bg-primary/10", "text-foreground");
    expect(selected.textContent).toContain("全部");
    const unselected = screen.getByRole("tab", { name: "成功" });
    expect(unselected).toHaveClass("text-muted-foreground");
    expect(unselected).not.toHaveClass("bg-primary/10");
  });

  it("点击未选中项触发 onChange 传入其 value", () => {
    const onChange = vi.fn();
    render(<ControlledTabs value="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "失败" }));
    expect(onChange).toHaveBeenCalledWith("failed");
  });

  it("所有 tab 都是 type=button（不会提交表单）", () => {
    render(<ControlledTabs value="all" onChange={vi.fn()} />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveAttribute("type", "button");
    }
  });
});

describe("SegmentedTabs 方向键（roving tabindex）", () => {
  it("ArrowRight 把焦点与选中移动到下一项并触发 onChange", () => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "全部" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = screen.getByRole("tab", { name: "成功" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(second);
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowLeft 把焦点与选中移动到上一项并触发 onChange", () => {
    render(<Harness />);
    const second = screen.getByRole("tab", { name: "成功" });
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    const first = screen.getByRole("tab", { name: "全部" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(first);
  });

  it("末项按 ArrowRight 回绕到首项", () => {
    render(<Harness />);
    const last = screen.getByRole("tab", { name: "失败" });
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "全部" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("首项按 ArrowLeft 回绕到末项", () => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "全部" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "失败" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});
