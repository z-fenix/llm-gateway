import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFormValidation } from "../useFormValidation";

describe("表单校验反馈", () => {
  it("空表单禁止提交但不提前喊错，失焦显示错误，修正后立即清除", () => {
    const { result, rerender } = renderHook(({ name }) => useFormValidation({ name: name.trim() ? undefined : "名称不能为空" }), { initialProps: { name: "" } });
    expect(result.current.invalid).toBe(true);
    expect(result.current.errors.name).toBeUndefined();
    act(() => result.current.touch("name"));
    expect(result.current.errors.name).toBe("名称不能为空");
    rerender({ name: "有效名称" });
    expect(result.current.invalid).toBe(false);
    expect(result.current.errors.name).toBeUndefined();
    act(() => result.current.reset());
    rerender({ name: "" });
    expect(result.current.errors.name).toBeUndefined();
  });
});
