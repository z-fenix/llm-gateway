import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ModelCombobox } from "../ModelCombobox";

const options = ["gpt-4o", "gpt-4o-mini", "deepseek-chat"];

describe("ModelCombobox", () => {
  it("渲染可输入的占位符", () => {
    render(<ModelCombobox value="" onChange={() => {}} options={options} />);
    expect(screen.getByPlaceholderText("输入或选择模型…")).toBeInTheDocument();
  });

  it("已有模型不隐藏其他候选，展开后可选择不同模型", () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="gpt-4o" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    fireEvent.click(screen.getByRole("option", { name: "deepseek-chat" }));
    expect(onChange).toHaveBeenCalledWith("deepseek-chat");
  });

  it("只有主动输入时才按输入过滤", () => {
    render(<ModelCombobox value="" onChange={() => {}} options={options} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "deep" } });
    expect(screen.getByRole("option", { name: "deepseek-chat" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "gpt-4o" })).not.toBeInTheDocument();
  });

  it("无匹配时仍允许手动输入", () => {
    const change = vi.fn();
    render(<ModelCombobox value="" onChange={change} options={options} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom-model" } });
    expect(change).toHaveBeenCalledWith("custom-model");
    expect(screen.getByText("无可用模型，可直接输入")).toBeInTheDocument();
  });

  it("刷新信号到达后自动展开新候选", () => {
    const { rerender } = render(<ModelCombobox value="saved-model" onChange={() => {}} options={[]} openSignal={0} />);
    rerender(<ModelCombobox value="saved-model" onChange={() => {}} options={options} openSignal={1} />);
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "deepseek-chat" })).toBeInTheDocument();
  });

  it("键盘移动候选时将活动项滚入菜单可视范围", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
    try {
      render(<ModelCombobox value="" onChange={() => {}} options={options} />);
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.instances[scroll.mock.instances.length - 1]).toBe(screen.getByRole("option", { name: "gpt-4o-mini" }));
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", descriptor);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("方向键与回车可选择模型", () => {
    const change = vi.fn();
    render(<ModelCombobox value="" onChange={change} options={options} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("gpt-4o");
  });
});
