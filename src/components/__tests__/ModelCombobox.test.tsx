import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ModelCombobox } from "../ModelCombobox";

const options = ["gpt-4o", "gpt-4o-mini", "deepseek-chat"];

describe("ModelCombobox", () => {
  it("渲染可输入的占位符", () => {
    render(<ModelCombobox value="" onChange={() => {}} options={options} />);
    expect(screen.getByPlaceholderText("输入或选择模型…")).toBeInTheDocument();
  });

  it("展开下拉选中候选后回填", () => {
    const onChange = vi.fn();
    render(<ModelCombobox value="" onChange={onChange} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    fireEvent.click(screen.getByText("gpt-4o-mini"));
    expect(onChange).toHaveBeenCalledWith("gpt-4o-mini");
  });

  it("候选按当前输入过滤", () => {
    render(
      <ModelCombobox value="deep" onChange={() => {}} options={options} />
    );
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.queryByText("gpt-4o")).not.toBeInTheDocument();
  });

  it("无匹配候选时提示可直接输入", () => {
    render(<ModelCombobox value="o3" onChange={() => {}} options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(screen.getByText("无可用模型，可直接输入")).toBeInTheDocument();
  });
});
