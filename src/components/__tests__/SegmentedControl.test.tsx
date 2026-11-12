import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SegmentedControl from "../SegmentedControl";

function Example() {
  const [value, setValue] = useState("first");
  return (
    <SegmentedControl
      label="内容分类"
      value={value}
      onChange={setValue}
      options={[
        { value: "first", label: "第一项" },
        { value: "second", label: "第二项" },
        { value: "third", label: "第三项" },
      ]}
    />
  );
}

describe("SegmentedControl", () => {
  it("仅当前项进入 Tab 顺序，点击切换选择状态", () => {
    render(<Example />);
    expect(screen.getByRole("tablist", { name: "内容分类" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "第一项" })).toHaveAttribute("tabindex", "0");
    const second = screen.getByRole("tab", { name: "第二项" });
    expect(second).toHaveAttribute("tabindex", "-1");
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "第一项" })).toHaveAttribute("aria-selected", "false");
  });

  it("方向键循环并移动焦点，支持 Home 和 End", () => {
    render(<Example />);
    const first = screen.getByRole("tab", { name: "第一项" });
    const second = screen.getByRole("tab", { name: "第二项" });
    const third = screen.getByRole("tab", { name: "第三项" });
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(third).toHaveFocus();
    expect(third).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
  });
});
