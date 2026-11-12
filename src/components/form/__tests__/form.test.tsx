import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { SecretInput } from "../SecretInput";
import { FormField } from "../FormField";
import { FormFooter } from "../FormFooter";

/** 受控 Harness：模拟父组件持有 value，供 reveal 重置等受控行为测试。 */
function SecretHarness({
  initial,
  ...rest
}: { initial: string } & Omit<
  Parameters<typeof SecretInput>[0],
  "value" | "onChange" | "ariaLabel"
>) {
  const [value, setValue] = useState(initial);
  return (
    <SecretInput
      value={value}
      onChange={setValue}
      ariaLabel="API 密钥"
      {...rest}
    />
  );
}

describe("SecretInput", () => {
  it("默认掩码：input type=password，reveal 按钮呈未按下态", () => {
    render(<SecretInput value="sk-abc" onChange={() => {}} ariaLabel="API 密钥" />);
    const input = screen.getByLabelText("API 密钥");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "显示密钥" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.queryByRole("button", { name: "隐藏密钥" })).not.toBeInTheDocument();
  });

  it("仅值非空时出现 reveal 按钮（aria-label=显示密钥，aria-pressed=false）", () => {
    const { rerender } = render(
      <SecretInput value="" onChange={() => {}} ariaLabel="API 密钥" />
    );
    expect(screen.queryByRole("button", { name: "显示密钥" })).not.toBeInTheDocument();

    rerender(<SecretInput value="sk-x" onChange={() => {}} ariaLabel="API 密钥" />);
    const reveal = screen.getByRole("button", { name: "显示密钥" });
    expect(reveal).toHaveAttribute("type", "button");
    expect(reveal).toHaveAttribute("aria-pressed", "false");
  });

  it("点击 reveal 切换 type 与 aria-pressed / aria-label", () => {
    render(<SecretInput value="sk-abc" onChange={() => {}} ariaLabel="API 密钥" />);
    const input = screen.getByLabelText("API 密钥");

    fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏密钥" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "隐藏密钥" }));
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "显示密钥" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("值变更后 reveal 重置为掩码", () => {
    render(<SecretHarness initial="sk-old" />);
    fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
    const input = screen.getByLabelText("API 密钥");
    expect(input).toHaveAttribute("type", "text");

    fireEvent.change(input, { target: { value: "sk-new" } });
    expect(input).toHaveAttribute("type", "password");
  });

  it("onChange 回调收到 trim 后的值", () => {
    const onChange = vi.fn();
    render(<SecretInput value="" onChange={onChange} ariaLabel="API 密钥" />);
    fireEvent.change(screen.getByLabelText("API 密钥"), {
      target: { value: "  sk-with-space  " },
    });
    expect(onChange).toHaveBeenCalledWith("sk-with-space");
  });

  it("ariaLabel 透传到 input，invalid 时 aria-invalid=true", () => {
    render(
      <SecretInput value="" onChange={() => {}} ariaLabel="API 密钥" invalid />
    );
    const input = screen.getByLabelText("API 密钥");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("未传 invalid 时不带 aria-invalid 属性", () => {
    render(<SecretInput value="" onChange={() => {}} ariaLabel="API 密钥" />);
    expect(screen.getByLabelText("API 密钥")).not.toHaveAttribute("aria-invalid");
  });

  it("saved 作为 placeholder 提示", () => {
    render(
      <SecretInput
        value=""
        onChange={() => {}}
        saved="已保存，留空保持不变"
        ariaLabel="API 密钥"
      />
    );
    expect(
      screen.getByPlaceholderText("已保存，留空保持不变")
    ).toBeInTheDocument();
  });

  it("disabled 时 input 与 reveal 按钮均禁用", () => {
    render(
      <SecretInput value="sk-abc" onChange={() => {}} disabled ariaLabel="API 密钥" />
    );
    const input = screen.getByLabelText("API 密钥");
    expect(input).toBeDisabled();
    const reveal = screen.getByRole("button", { name: "显示密钥" });
    expect(reveal).toBeDisabled();

    fireEvent.click(reveal);
    expect(input).toHaveAttribute("type", "password");
  });

  it("autoComplete=new-password", () => {
    render(<SecretInput value="" onChange={() => {}} ariaLabel="API 密钥" />);
    expect(screen.getByLabelText("API 密钥")).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
  });
});

describe("FormField", () => {
  it("label 渲染 htmlFor 关联控件", () => {
    render(
      <FormField label="名称" htmlFor="name">
        <input id="name" />
      </FormField>
    );
    const label = screen.getByText("名称");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", "name");
    expect(screen.getByLabelText("名称")).toBeInTheDocument();
  });

  it("required 时 label 带 * 标记", () => {
    render(
      <FormField label="支持模型" required>
        <input />
      </FormField>
    );
    const label = screen.getByText(/支持模型/);
    expect(label.textContent).toContain("*");
  });

  it("非 required 不带 * 标记", () => {
    render(
      <FormField label="名称">
        <input />
      </FormField>
    );
    expect(screen.getByText("名称").textContent).not.toContain("*");
  });

  it("error 渲染为 role=alert 的 p，带 text-destructive", () => {
    render(
      <FormField label="名称" error="名称不能为空">
        <input />
      </FormField>
    );
    const alert = screen.getByRole("alert");
    expect(alert.tagName).toBe("P");
    expect(alert).toHaveTextContent("名称不能为空");
    expect(alert).toHaveClass("text-destructive");
  });

  it("hint 渲染为 text-faint 提示行", () => {
    render(
      <FormField label="名称" hint="仅本地可见">
        <input />
      </FormField>
    );
    const hint = screen.getByText("仅本地可见");
    expect(hint).toHaveClass("text-faint");
  });

  it("无 error 时不出现 role=alert", () => {
    render(
      <FormField label="名称">
        <input />
      </FormField>
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("children 正常渲染", () => {
    render(
      <FormField label="名称">
        <input id="child" placeholder="子控件" />
      </FormField>
    );
    expect(screen.getByPlaceholderText("子控件")).toBeInTheDocument();
  });
});

describe("FormFooter", () => {
  it("默认文案：取消 / 应用，均 type=button", () => {
    render(<FormFooter onCancel={() => {}} onSubmit={() => {}} />);
    const cancel = screen.getByRole("button", { name: "取消" });
    const submit = screen.getByRole("button", { name: "应用" });
    expect(cancel).toHaveAttribute("type", "button");
    expect(submit).toHaveAttribute("type", "button");
    expect(cancel).toBeEnabled();
    expect(submit).toBeEnabled();
  });

  it("busy 时取消禁用、提交文案切换为应用中且禁用", () => {
    render(<FormFooter onCancel={() => {}} onSubmit={() => {}} busy />);
    const cancel = screen.getByRole("button", { name: "取消" });
    const submit = screen.getByRole("button", { name: "应用中" });
    expect(cancel).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("button", { name: "应用" })).not.toBeInTheDocument();
  });

  it("submitDisabled 时仅提交禁用、取消可用", () => {
    render(
      <FormFooter onCancel={() => {}} onSubmit={() => {}} submitDisabled />
    );
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("点击触发 onCancel / onSubmit", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<FormFooter onCancel={onCancel} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("自定义文案标签生效", () => {
    render(
      <FormFooter
        onCancel={() => {}}
        onSubmit={() => {}}
        cancelLabel="关闭"
        submitLabel="保存"
        busyLabel="保存中"
      />
    );
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();

    render(
      <FormFooter
        onCancel={() => {}}
        onSubmit={() => {}}
        busy
        cancelLabel="关闭"
        submitLabel="保存"
        busyLabel="保存中"
      />
    );
    expect(screen.getByRole("button", { name: "保存中" })).toBeInTheDocument();
  });
});
