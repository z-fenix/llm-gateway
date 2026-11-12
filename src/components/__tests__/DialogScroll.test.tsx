import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

describe("弹窗内部滚动", () => {
  it("仅正文可滚动，标题和操作留在滚动区外", () => {
    render(<Dialog open><DialogContent><DialogHeader><DialogTitle>长表单</DialogTitle><DialogDescription>编辑内容</DialogDescription></DialogHeader><DialogBody data-testid="body">长内容</DialogBody><DialogFooter><button>保存</button></DialogFooter></DialogContent></Dialog>);
    const body = screen.getByTestId("body");
    expect(body).toHaveClass("overflow-y-auto", "min-h-0");
    expect(screen.getByRole("dialog")).toHaveClass("overflow-hidden");
    expect(body).not.toContainElement(screen.getByRole("heading", { name: "长表单" }));
    expect(body).not.toContainElement(screen.getByRole("button", { name: "保存" }));
  });
});
