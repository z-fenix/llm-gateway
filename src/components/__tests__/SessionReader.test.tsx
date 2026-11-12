import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SessionReader from "../sessions/SessionReader";
import type { SessionMessage } from "../../types";
const messages: SessionMessage[] = [{role:"user",content:"检查文件"},{role:"assistant",content:"working",blocks:[{type:"tool_call",id:"a",name:"Read",input:{path:"a.ts"}}]},{role:"tool",content:"secret needle",blocks:[{type:"tool_result",id:"a",output:"secret needle",status:"error"}]},{role:"assistant",content:"## 完成\n\n```ts\nconst n = 1;\n```"}];
describe("会话阅读交互", () => {
  it("工具过程折叠，打开后显示失败和真实输入输出", () => {
    render(<SessionReader messages={messages} />);
    expect(screen.queryByText("secret needle")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:/执行过程/}));
    fireEvent.click(screen.getByRole("button",{name:/Read/}));
    expect(screen.getByText("secret needle")).toBeVisible();
    expect(screen.getByText(/a.ts/)).toBeVisible();
    expect(screen.getByText("失败")).toBeInTheDocument();
    expect(screen.getByRole("heading",{name:"完成"})).toBeInTheDocument();
  });
  it("正文搜索自动展开折叠过程并定位；清除后恢复折叠", () => {
    render(<SessionReader messages={messages} />);
    fireEvent.change(screen.getByRole("searchbox",{name:"查找会话正文"}),{target:{value:"needle"}});
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(screen.getByText(/secret/)).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"清除查找"}));
    expect(screen.queryByText("secret needle")).not.toBeInTheDocument();
  });
  it("Markdown 不执行 HTML，不自动加载远程图片，不创建危险链接", () => {
    const {container} = render(<SessionReader messages={[{role:"assistant",content:'<script>alert(1)</script>\n\n![track](https://example.com/track)\n\n[bad](javascript:alert(1))'}]} />);
    expect(container.querySelector("script,img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/图片未自动加载/)).toBeInTheDocument();
  });
  it("惰性阅读区挂载后再次定位窄屏详情，避免加载前高度不足而停在列表", () => {
    const width=window.innerWidth;
    const original=HTMLElement.prototype.scrollIntoView;
    const scroll=vi.fn();
    Object.defineProperty(window,"innerWidth",{configurable:true,value:390});
    HTMLElement.prototype.scrollIntoView=scroll;
    try {
      render(<section aria-label="会话详情"><SessionReader messages={messages}/></section>);
      expect(scroll.mock.instances.some(node=>node.getAttribute("aria-label")==="会话详情")).toBe(true);
    } finally {
      Object.defineProperty(window,"innerWidth",{configurable:true,value:width});
      HTMLElement.prototype.scrollIntoView=original;
    }
  });
  it("复制会话包含工具结果；有恢复命令才显示复制入口", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    render(<SessionReader messages={messages} resumeCommand="claude --resume synthetic" />);
    fireEvent.click(screen.getByRole("button",{name:"复制恢复命令"}));
    expect(writeText).toHaveBeenCalledWith("claude --resume synthetic");
    fireEvent.click(screen.getByRole("button",{name:"复制会话"}));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("secret needle"));
  });
});
