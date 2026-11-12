import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatCard } from "../StatCard";

describe("StatCard 渲染", () => {
  it("渲染 label 与 value", () => {
    render(<StatCard label="总调用" value="12345" />);
    expect(screen.getByText("总调用")).toBeInTheDocument();
    expect(screen.getByText("12345")).toBeInTheDocument();
  });

  it("label 使用 muted 小字样式", () => {
    render(<StatCard label="总调用" value="12345" />);
    expect(screen.getByText("总调用")).toHaveClass("text-xs", "text-muted-foreground");
  });

  it("value 使用等宽大字号与 tabular-nums", () => {
    render(<StatCard label="总调用" value="12345" />);
    const value = screen.getByText("12345");
    expect(value).toHaveClass("font-mono", "text-2xl", "font-bold", "tabular-nums");
  });

  it("渲染 hint 为 value 下方的 muted 小字", () => {
    render(<StatCard label="成功率" value="98.2%" hint="较昨日 +1.2%" />);
    expect(screen.getByText("较昨日 +1.2%")).toBeInTheDocument();
    expect(screen.getByText("较昨日 +1.2%")).toHaveClass("text-muted-foreground");
  });

  it("未传 hint 时不渲染 hint 元素", () => {
    render(<StatCard label="总调用" value="12345" />);
    expect(document.querySelector(".text-2xl")?.nextElementSibling).toBeNull();
  });
});

describe("StatCard 进度条", () => {
  it("progress 在范围内时渲染 bg-primary 填充，宽度按百分比", () => {
    render(<StatCard label="命中率" value="72%" progress={72} />);
    const track = document.querySelector(".h-1\\.5.rounded-full.bg-muted");
    expect(track).not.toBeNull();
    const fill = track!.firstElementChild as HTMLElement;
    expect(fill).toHaveClass("bg-primary");
    expect(fill.style.width).toBe("72%");
  });

  it("progress 超过 100 时收敛到 100%", () => {
    render(<StatCard label="命中率" value="150%" progress={150} />);
    const fill = document.querySelector(
      ".h-1\\.5.rounded-full.bg-muted"
    )!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("progress 为负数时收敛到 0%", () => {
    render(<StatCard label="命中率" value="0%" progress={-5} />);
    const fill = document.querySelector(
      ".h-1\\.5.rounded-full.bg-muted"
    )!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("未传 progress 时不渲染进度条", () => {
    render(<StatCard label="总调用" value="12345" />);
    expect(document.querySelector(".h-1\\.5.rounded-full.bg-muted")).toBeNull();
  });
});
