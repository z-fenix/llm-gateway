import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import PageHeader, { PageNavigation } from "../PageHeader";

describe("共享页面导航", () => {
  it("分组标题在页签之前，保留子页操作且只有一个主标题", () => {
    render(<PageNavigation.Provider value={{ title: "资源", description: "统一管理资源", navigation: <nav aria-label="资源类型">知识库 / Prompt</nav> }}><div><PageHeader title="知识库" action={<button>新建知识库</button>} /><p>文档列表</p></div></PageNavigation.Provider>);
    const heading = screen.getByRole("heading", { level: 1, name: "资源" });
    const navigation = screen.getByRole("navigation", { name: "资源类型" });
    expect(heading.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "新建知识库" })).toBeInTheDocument();
  });
});
