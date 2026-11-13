import { ChevronRight, Terminal, CircleAlert, Brain, MessageSquare } from "lucide-react";
import type { ReaderStep } from "../../lib/sessionReader";
import SessionMarkdown, { HighlightText } from "./SessionMarkdown";
import { cn } from "../../lib/utils";

export default function SessionStep({step,query,open,onToggle}: {step:ReaderStep;query:string;open:boolean;onToggle:()=>void}) {
  const shown = open || !!query;
  const tool = step.kind === "tool";
  const failed = step.status === "error" || step.status === "interrupted";
  const Icon = failed ? CircleAlert : tool ? Terminal : step.kind === "thinking" ? Brain : MessageSquare;
  const title = tool ? step.name || "工具输出" : step.kind === "thinking" ? "思考" : "过程说明";
  const input = step.input == null ? "" : typeof step.input === "string" ? step.input : JSON.stringify(step.input,null,2);
  return <article className="min-w-0 border-l border-border pl-3">
    <button type="button" aria-expanded={shown} aria-controls={`detail-${step.key}`} className="flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onToggle}>
      <ChevronRight size={13} className={cn("shrink-0 transition-transform",shown&&"rotate-90")}/><Icon size={14} className={cn("shrink-0",failed?"text-destructive":"text-muted-foreground")}/>
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {tool && <span className={cn("shrink-0 text-[10px]",failed?"text-destructive":"text-muted-foreground")}>{failed?"失败":step.status==="success"?"完成":step.output!==undefined?"已返回":"状态未知"}</span>}
      <span className="sr-only">{tool ? "TOOL" : ""}</span>
    </button>
    {shown && <div id={`detail-${step.key}`} className="min-w-0 space-y-3 pb-3 text-[13px] leading-[1.65]">
      {input && <div><p className="mb-1 text-[11px] text-muted-foreground">输入参数</p><pre className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-xs [overflow-wrap:anywhere]"><HighlightText text={input} query={query}/></pre></div>}
      {step.output!==undefined && <div><p className="mb-1 text-[11px] text-muted-foreground">输出结果</p><pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-xs [overflow-wrap:anywhere]"><HighlightText text={step.output} query={query}/></pre></div>}
      {step.text && <SessionMarkdown content={step.text} query={query}/>}
      {tool && !input && step.output===undefined && <p className="text-xs text-muted-foreground">记录中没有工具参数或结果。</p>}
    </div>}
  </article>;
}
