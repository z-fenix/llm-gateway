import { describe, expect, it } from "vitest";
import { buildSessionTurns, readerRows, findReaderRows, transcriptMarkdown } from "../sessionReader";
import type { SessionMessage } from "../../types";
const m = (role: string, content: string, blocks?: unknown[]): SessionMessage => ({ role, content, ...(blocks ? { blocks } : {}) } as SessionMessage);
describe("会话阅读模型", () => {
  it("按提问分轮，把工具关联输入/输出，中间说明折叠而保留最后回复", () => {
    const turns = buildSessionTurns([
      m("user", "检查文件"), m("assistant", "先读取"),
      m("assistant", "tool", [{type:"tool_call",id:"a",name:"Read",input:{path:"a.ts"}}]),
      m("tool", "file", [{type:"tool_result",id:"a",output:"file",status:"success"}]),
      m("assistant", "已检查"), m("user", "再试一次"), m("assistant", "完成"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].question?.text).toBe("检查文件");
    expect(turns[0].steps[1]).toMatchObject({ kind:"tool", name:"Read", input:{path:"a.ts"}, output:"file", status:"success" });
    expect(turns[0].final?.text).toBe("已检查");
    expect(turns[1].final?.text).toBe("完成");
  });
  it("混合 user 工具结果与新问题不会丢掉工具结果或新增伪问题", () => {
    const turns = buildSessionTurns([m("user", "Q"), m("assistant", "tool", [{type:"tool_call",id:"a",name:"Read",input:{}}]), m("user", "result and Q2", [{type:"tool_result",id:"a",output:"ok",status:"success"},{type:"text",text:"Q2"}])]);
    expect(turns).toHaveLength(2);
    expect(turns[0].steps[0].output).toBe("ok");
    expect(turns[1].question?.text).toBe("Q2");
  });
  it("只有工具调用时不伪造最终回复，孤立结果显示未知工具", () => {
    const turns = buildSessionTurns([m("tool", "orphan"),m("assistant","[Tool: Read]")]);
    expect(turns[0].final).toBeUndefined();
    expect(turns[0].steps[0]).toMatchObject({kind:"tool",output:"orphan"});
  });
  it("最后事件是工具返回时，中途助手说明不能冒充最终回复", () => {
    const turns = buildSessionTurns([m("user","Q"),m("assistant","call",[{type:"tool_call",id:"a",name:"Read",input:{}}]),m("assistant","正在等待工具"),m("tool","ok",[{type:"tool_result",id:"a",output:"ok",status:"success"}])]);
    expect(turns[0].final).toBeUndefined();
    expect(turns[0].steps.some(s=>s.text==="正在等待工具")).toBe(true);
  });
  it("搜索包含折叠工具输出；筛选不丢失问答且复制保留工具原文", () => {
    const turns = buildSessionTurns([m("user","Q"), m("tool","needle"), m("assistant","A")]);
    const rows = readerRows(turns, "all", new Set(), true);
    expect(findReaderRows(rows,"NEEDLE")).toHaveLength(1);
    expect(readerRows(turns,"conversation",new Set(),false).map(r=>r.kind)).toEqual(["question","final"]);
    expect(transcriptMarkdown(turns)).toContain("needle");
  });
});
