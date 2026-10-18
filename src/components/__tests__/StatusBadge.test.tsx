import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusBadge } from "../StatusBadge";
import { httpStatusSemantic, riskSemantic, type Semantic } from "../../lib/semantics";

const SEMANTIC_TEXT_CLASS: Record<Semantic, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-faint",
};

const SEMANTIC_BG_CLASS: Record<Semantic, string> = {
  success: "bg-success/10",
  warning: "bg-warning/10",
  danger: "bg-danger/10",
  info: "bg-info/10",
  neutral: "bg-faint/10",
};

describe("StatusBadge 渲染", () => {
  it.each([
    ["success"],
    ["warning"],
    ["danger"],
    ["info"],
    ["neutral"],
  ] as const)("semantic=%s 使用对应语义色文字与 10% 底色", (semantic) => {
    render(<StatusBadge semantic={semantic}>状态</StatusBadge>);
    const el = screen.getByText("状态");
    expect(el).toHaveClass(SEMANTIC_TEXT_CLASS[semantic]);
    expect(el).toHaveClass(SEMANTIC_BG_CLASS[semantic]);
  });

  it("基础样式：小号圆角胶囊", () => {
    render(
      <StatusBadge semantic="success">
        <span>ok</span>
      </StatusBadge>
    );
    const el = screen.getByText("ok").parentElement as HTMLElement;
    expect(el).toHaveClass("rounded");
    expect(el).toHaveClass("text-xs");
    expect(el.tagName).toBe("SPAN");
  });

  it("透传 className", () => {
    render(
      <StatusBadge semantic="danger" className="ml-2">
        错误
      </StatusBadge>
    );
    expect(screen.getByText("错误")).toHaveClass("ml-2", "text-danger");
  });
});

describe("httpStatusSemantic", () => {
  it("2xx → success", () => {
    expect(httpStatusSemantic(200)).toBe("success");
    expect(httpStatusSemantic(204)).toBe("success");
  });

  it("429 → warning", () => {
    expect(httpStatusSemantic(429)).toBe("warning");
  });

  it("其余 4xx / 5xx → danger", () => {
    expect(httpStatusSemantic(400)).toBe("danger");
    expect(httpStatusSemantic(401)).toBe("danger");
    expect(httpStatusSemantic(403)).toBe("danger");
    expect(httpStatusSemantic(500)).toBe("danger");
    expect(httpStatusSemantic(502)).toBe("danger");
  });

  it("3xx 及 0 等其他值 → neutral", () => {
    expect(httpStatusSemantic(301)).toBe("neutral");
    expect(httpStatusSemantic(302)).toBe("neutral");
    expect(httpStatusSemantic(0)).toBe("neutral");
  });
});

describe("riskSemantic（大小写不敏感）", () => {
  it.each([
    ["clean", "neutral"],
    ["CLEAN", "neutral"],
    ["Clean", "neutral"],
    ["info", "info"],
    ["INFO", "info"],
    ["low", "success"],
    ["Low", "success"],
    ["medium", "warning"],
    ["MEDIUM", "warning"],
    ["high", "danger"],
    ["High", "danger"],
    ["critical", "danger"],
    ["CRITICAL", "danger"],
  ] as const)("%s → %s", (level, want) => {
    expect(riskSemantic(level)).toBe(want);
  });

  it("未知值 → neutral", () => {
    expect(riskSemantic("")).toBe("neutral");
    expect(riskSemantic("unknown")).toBe("neutral");
    expect(riskSemantic("moderate")).toBe("neutral");
  });
});
