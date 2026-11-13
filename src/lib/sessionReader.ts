import type { SessionBlock, SessionMessage } from "../types";

export interface ReaderPart { text: string; ts?: number | null }
export interface ReaderStep {
  key: string; kind: "tool" | "thinking" | "note";
  text?: string; id?: string | null; name?: string | null; input?: unknown;
  output?: string; status?: string; ts?: number | null;
}
export interface SessionTurn { key: string; question?: ReaderPart; steps: ReaderStep[]; final?: ReaderPart }
export type ReaderFilter = "all" | "conversation" | "tools";
export interface ReaderRow {
  key: string; turn: number; kind: "question" | "process" | "step" | "final";
  text: string; part?: ReaderPart; step?: ReaderStep;
}
export function effectiveBlocks(message: SessionMessage): SessionBlock[] {
  if (message.blocks?.length) return message.blocks;
  if (message.role === "tool") return [{ type: "tool_result", output: message.content, status: "unknown" }];
  const tool = /^\[Tool:\s*([^\]]+)\]$/.exec(message.content.trim());
  if (tool && message.role === "assistant") return [{type:"tool_call",name:tool[1],input:null}];
  return message.content ? [{ type: "text", text: message.content }] : [];
}
export function buildSessionTurns(messages: SessionMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let current: SessionTurn | undefined;
  let serial = 0;
  let endsWithAssistantText = false;
  const ensure = () => current ??= { key: `turn-${turns.length}`, steps: [] };
  const finish = () => {
    if (!current) return;
    const last = current.steps[current.steps.length - 1];
    if (last?.kind === "note" && endsWithAssistantText) { current.final = {text:last.text ?? "", ts:last.ts}; current.steps.pop(); }
    turns.push(current); current = undefined;
    endsWithAssistantText = false;
  };
  const appendBlock = (block: SessionBlock, message: SessionMessage) => {
    const turn = ensure();
    endsWithAssistantText = block.type === "text" && message.role === "assistant";
    if (block.type === "tool_result") {
      const call = block.id ? [...turn.steps].reverse().find(s => s.kind === "tool" && s.id === block.id && s.output === undefined) : undefined;
      if (call) { call.output = block.output; call.status = block.status; }
      else turn.steps.push({key:`step-${serial++}`,kind:"tool",id:block.id,output:block.output,status:block.status,ts:message.ts});
      return;
    }
    const base = {key:`step-${serial++}`,ts:message.ts};
    if (block.type === "tool_call") turn.steps.push({...base,kind:"tool",id:block.id,name:block.name,input:block.input,status:"unknown"});
    else if (block.type === "thinking") turn.steps.push({...base,kind:"thinking",text:block.text});
    else if (block.type === "text") turn.steps.push({...base,kind:message.role === "assistant" ? "note" : "thinking",text:block.text});
  };
  for (const message of messages) {
    const blocks = effectiveBlocks(message);
    if (message.role === "user") {
      // User wrappers may contain results for the prior turn plus a new question.
      for (const block of blocks) if (block.type === "tool_result") appendBlock(block, message);
      const text = blocks.filter(b => b.type === "text").map(b => (b as {text:string}).text).join("\n");
      if (text.trim()) { finish(); ensure().question = {text,ts:message.ts}; }
      for (const block of blocks) if (block.type !== "tool_result" && block.type !== "text") appendBlock(block, message);
    } else {
      // Gemini can store call + result + reply in one message. Preserve block order.
      for (const block of blocks) appendBlock(block, message);
    }
  }
  finish();
  return turns;
}
export const stepText = (s: ReaderStep) => [s.name, s.text, s.input == null ? "" : typeof s.input === "string" ? s.input : JSON.stringify(s.input,null,2), s.output].filter(Boolean).join("\n");
export function readerRows(turns: SessionTurn[], filter: ReaderFilter, expanded: Set<string>, searching: boolean): ReaderRow[] {
  const rows: ReaderRow[] = [];
  turns.forEach((turn, index) => {
    if (turn.question && filter !== "tools") rows.push({key:`${turn.key}-q`,turn:index,kind:"question",part:turn.question,text:turn.question.text});
    const steps = filter === "tools" ? turn.steps.filter(s=>s.kind==="tool") : turn.steps;
    if (steps.length && filter !== "conversation") {
      rows.push({key:`${turn.key}-process`,turn:index,kind:"process",text:`${steps.length} 个执行步骤`});
      if (searching || expanded.has(turn.key)) for (const step of steps) rows.push({key:step.key,turn:index,kind:"step",step,text:stepText(step)});
    }
    if (turn.final && filter !== "tools") rows.push({key:`${turn.key}-a`,turn:index,kind:"final",part:turn.final,text:turn.final.text});
  });
  return rows;
}
export function findReaderRows(rows: ReaderRow[], query: string): number[] {
  const q = query.trim().toLocaleLowerCase();
  return q ? rows.flatMap((row,i) => row.kind !== "process" && row.text.toLocaleLowerCase().includes(q) ? [i] : []) : [];
}
export function transcriptMarkdown(turns: SessionTurn[]): string {
  return turns.map((t,i) => [`## 第 ${i+1} 轮`,t.question ? `### 用户\n\n${t.question.text}` : "",...t.steps.map(s=>`### ${s.kind === "tool" ? s.name || "工具输出" : s.kind === "thinking" ? "思考" : "过程说明"}\n\n${stepText(s)}`),t.final ? `### 助手\n\n${t.final.text}` : ""].filter(Boolean).join("\n\n")).join("\n\n---\n\n");
}
