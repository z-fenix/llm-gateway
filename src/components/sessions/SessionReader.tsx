import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ChevronDown, ChevronUp, Copy, List, Search, X } from "lucide-react";
import type { SessionMessage } from "../../types";
import { buildSessionTurns, findReaderRows, readerRows, transcriptMarkdown, type ReaderFilter, type ReaderRow } from "../../lib/sessionReader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import SessionMarkdown, { copySessionText } from "./SessionMarkdown";
import SessionStep from "./SessionStep";
import { cn } from "../../lib/utils";

export default function SessionReader({messages,resumeCommand}: {messages:SessionMessage[];resumeCommand?:string|null}) {
  const turns = useMemo(()=>buildSessionTurns(messages),[messages]);
  const [filter,setFilter] = useState<ReaderFilter>("all");
  const [query,setQuery] = useState("");
  const [expanded,setExpanded] = useState<Set<string>>(new Set());
  const [expandedSteps,setExpandedSteps] = useState<Set<string>>(new Set());
  const [hit,setHit] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const readerRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if(window.innerWidth < 1024) readerRoot.current?.closest<HTMLElement>('[aria-label="会话详情"]')?.scrollIntoView?.({block:"start"});
  }, []);
  const rows = useMemo(()=>readerRows(turns,filter,expanded,!!query.trim()),[turns,filter,expanded,query]);
  const hits = useMemo(()=>findReaderRows(rows,query),[rows,query]);
  const large = rows.length > 80;
  const virtual = useVirtualizer({count:large?rows.length:0,getScrollElement:()=>scroller.current,estimateSize:i=>rows[i]?.kind==="process"?44:160,overscan:6,getItemKey:i=>rows[i].key});
  const target = hits.length ? hits[hit % hits.length] : -1;
  const jump = (index:number) => {
    if (large) virtual.scrollToIndex(index,{align:"start"});
    else scroller.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView?.({block:"nearest"});
  };
  useEffect(()=>{setHit(0);},[query,filter]);
  useEffect(()=>{if(target>=0) jump(target);},[target,large]);
  const toggle = (key:string) => setExpanded(previous=>{const next=new Set(previous);next.has(key)?next.delete(key):next.add(key);return next;});
  const toggleStep = (key:string) => setExpandedSteps(previous=>{const next=new Set(previous);next.has(key)?next.delete(key):next.add(key);return next;});
  const selectFilter = (value:ReaderFilter) => {
    setFilter(value); setQuery("");
    if(value === "tools") setExpanded(new Set(turns.filter(turn=>turn.steps.some(step=>step.kind === "tool")).map(turn=>turn.key)));
  };
  const renderRow = (row:ReaderRow,index:number) => <div className={cn("min-w-0 py-1",target===index&&"rounded-lg ring-1 ring-primary/50")}>
    {row.kind==="process" ? <button type="button" aria-expanded={expanded.has(turns[row.turn].key)||!!query.trim()} onClick={()=>toggle(turns[row.turn].key)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent"><ChevronDown size={14} className={cn(!expanded.has(turns[row.turn].key)&&!query.trim()&&"-rotate-90")}/><span>执行过程</span><span>{row.text}</span>{turns[row.turn].steps.some(s=>s.status==="error")&&<span className="text-destructive">含失败步骤</span>}</button>
      : row.kind==="step" ? <div className="px-3"><SessionStep key={row.step!.key} step={row.step!} query={query.trim()} open={expandedSteps.has(row.step!.key)} onToggle={()=>toggleStep(row.step!.key)}/></div>
      : <article className={cn("min-w-0 rounded-lg p-4",row.kind==="question"?"bg-background":"border-b border-border/60")}>
        <div className="mb-2 flex items-center gap-2 text-[10px] text-muted-foreground"><span className="font-semibold">{row.kind==="question"?"USER":"ASSISTANT"}</span><span>第 {row.turn+1} 轮{row.kind==="final"?" · 最终回复":""}</span>{row.part?.ts!=null&&Number.isFinite(row.part.ts)&&<time className="ml-auto" dateTime={new Date(row.part.ts).toISOString()}>{new Date(row.part.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time>}<Button size="icon" variant="ghost" className="ml-auto h-6 w-6" aria-label={row.kind==="question"?"复制提问":"复制回复"} onClick={()=>void copySessionText(row.text)}><Copy size={12}/></Button></div>
        <div className="text-[13px] leading-[1.65]"><SessionMarkdown content={row.text} query={query.trim()}/></div>
      </article>}
  </div>;
  return <div ref={readerRoot} className="flex h-[560px] min-h-0 min-w-0 flex-none flex-col gap-3 lg:h-auto lg:flex-1" data-session-reader>
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="segmented-control" aria-label="阅读筛选">{([["all","全部"],["conversation","对话"],["tools","工具"]] as const).map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} className={cn("segmented-item px-3 text-xs",filter===value&&"bg-card text-foreground shadow-sm")} onClick={()=>selectFilter(value)}>{label}</button>)}</div>
      <Button variant="ghost" size="sm" className="text-xs" onClick={()=>setExpanded(expanded.size===turns.length?new Set():new Set(turns.map(t=>t.key)))}>{expanded.size===turns.length?"收起过程":"展开过程"}</Button>
      <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="轮次目录"><List size={15}/></Button></PopoverTrigger><PopoverContent align="end" className="max-h-72 w-64 overflow-y-auto p-2"><p className="p-2 text-xs text-muted-foreground">共 {turns.length} 轮</p>{turns.map((t,i)=>{const rowIndex=rows.findIndex(row=>row.turn===i);return <button key={t.key} disabled={rowIndex<0} title={rowIndex<0?"该轮没有当前筛选下的内容":undefined} className="block w-full truncate rounded p-2 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50" onClick={()=>{if(rowIndex>=0)jump(rowIndex);}}>{i+1}. {t.question?.text.slice(0,60)||"会话开始"}</button>;})}</PopoverContent></Popover>
      <Button variant="ghost" size="icon" aria-label="复制会话" onClick={()=>void copySessionText(transcriptMarkdown(turns))}><Copy size={15}/></Button>
      {resumeCommand&&<Button variant="ghost" size="sm" className="text-xs" onClick={()=>void copySessionText(resumeCommand)}>复制恢复命令</Button>}
    </div>
    <div className="flex shrink-0 items-center gap-1.5"><div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"/><Input type="search" aria-label="查找会话正文" placeholder="查找正文、工具参数与输出" className="h-8 pl-8 text-xs" value={query} onChange={e=>{setFilter("all");setQuery(e.target.value);}} onKeyDown={e=>{if(e.key==="Enter"&&hits.length)setHit(i=>(i+(e.shiftKey?hits.length-1:1))%hits.length);}}/></div>{query&&<><span aria-live="polite" className="shrink-0 text-[11px] text-muted-foreground" title="匹配的消息或步骤">{hits.length?`${hit%hits.length+1} / ${hits.length}`:"无匹配"}</span><Button variant="ghost" size="icon" className="h-8 w-7" aria-label="上一处" disabled={!hits.length} onClick={()=>setHit(i=>(i+hits.length-1)%hits.length)}><ChevronUp size={14}/></Button><Button variant="ghost" size="icon" className="h-8 w-7" aria-label="下一处" disabled={!hits.length} onClick={()=>setHit(i=>(i+1)%hits.length)}><ChevronDown size={14}/></Button><Button variant="ghost" size="icon" className="h-8 w-7" aria-label="清除查找" onClick={()=>setQuery("")}><X size={14}/></Button></>}</div>
    <div ref={scroller} aria-label="会话消息" className="h-[480px] min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pr-1 lg:h-auto">
      {large ? <div className="relative w-full" style={{height:virtual.getTotalSize()}}>{virtual.getVirtualItems().map(item=><div key={item.key} ref={virtual.measureElement} data-index={item.index} data-row={item.index} className="absolute left-0 top-0 w-full" style={{transform:`translateY(${item.start}px)`}}>{renderRow(rows[item.index],item.index)}</div>)}</div> : rows.map((row,index)=><div data-row={index} key={row.key}>{renderRow(row,index)}</div>)}
      {!rows.length&&<p className="p-6 text-center text-sm text-muted-foreground">{messages.length?"当前筛选无内容":"无消息内容"}</p>}
    </div>
    <div className="flex shrink-0 items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{turns.length} 轮 · {messages.length} 条消息 · 本地只读记录</span><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={()=>{if(large)virtual.scrollToIndex(rows.length-1,{align:"end"});else if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;}}><ArrowDown size={13}/>跳到底部</Button></div>
  </div>;
}
