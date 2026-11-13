import { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";

export async function copySessionText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); toast.success("已复制"); return true; }
  catch { toast.error("复制失败，请检查剪贴板权限"); return false; }
}
export function HighlightText({text,query}: {text:string;query:string}) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`,"gi"));
  return <>{parts.map((part,i)=>i%2 ? <mark key={i} className="rounded-sm bg-warning/25 text-foreground">{part}</mark> : part)}</>;
}
function CodeBlock({children}: {children:React.ReactNode}) {
  const [copied,setCopied] = useState(false);
  const text = (node:React.ReactNode):string => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text(node.props.children) : "";
  return <div className="my-3 min-w-0 overflow-hidden rounded-lg border border-border bg-background"><div className="flex items-center justify-between border-b border-border px-3 py-1 text-[11px] text-muted-foreground"><span>代码</span><Button variant="ghost" size="sm" aria-label="复制代码" className="h-7" onClick={async()=>{setCopied(await copySessionText(text(children)));}}>{copied ? <Check size={13}/> : <Copy size={13}/>}复制</Button></div><pre className="m-0 max-w-full overflow-x-auto p-3 font-mono text-xs leading-relaxed">{children}</pre></div>;
}
export default function SessionMarkdown({content,query=""}: {content:string;query?:string}) {
  // Large transcripts remain readable without an unbounded Markdown parse.
  if (query || content.length > 65536) return <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"><HighlightText text={content} query={query}/></div>;
  return <div className="session-markdown min-w-0 break-words [overflow-wrap:anywhere]"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={(url)=>/^(https?:|mailto:)/i.test(url) ? defaultUrlTransform(url) : ""} components={{
    pre:({children})=><CodeBlock>{children}</CodeBlock>,
    img:({alt})=><span className="inline-block rounded border border-border px-2 py-1 text-xs text-muted-foreground">图片未自动加载{alt ? `：${alt}` : ""}</span>,
    a:({href,children})=>href ? <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2">{children}</a> : <span>{children}</span>,
    table:({children})=><div className="my-3 max-w-full overflow-x-auto"><table>{children}</table></div>,
  }}>{content}</ReactMarkdown></div>;
}
