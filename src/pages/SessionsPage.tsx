import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, Search, Trash2, ScrollText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { NEUTRAL_TAG } from "../lib/tagStyles";
import type { SessionMeta, SessionMessage } from "../types";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

const SessionReader = lazy(() => import("../components/sessions/SessionReader"));

const PROVIDERS = [
  { id: "all", label: "全部" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function relativeTime(ts?: number | null): string {
  if (!ts) return "";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

export default function SessionsPage() {
  const messageRequest = useRef(0);
  const detailRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [providerFilter, setProviderFilter] = useState<ProviderId>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [secs, setSecs] = useRefreshInterval("sessions-refresh");
  const navigate = useNavigate();

  const handleError = (err: unknown) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
  };

  const loadSessions = async () => {
    setError(null);
    setLoading(true);
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      handleError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
    return () => { messageRequest.current += 1; };
  }, []);

  useEffect(() => {
    if (!secs) return;
    const t = setInterval(() => {
      loadSessions();
    }, secs * 1000);
    return () => clearInterval(t);
  }, [secs]);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const kw = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (providerFilter !== "all" && s.providerId !== providerFilter) return false;
      if (!kw) return true;
      return (
        (s.title ?? "").toLowerCase().includes(kw) ||
        (s.projectDir ?? "").toLowerCase().includes(kw) ||
        s.sessionId.toLowerCase().includes(kw)
      );
    });
  }, [sessions, providerFilter, search]);

  const sessionKey = (s: SessionMeta) => `${s.providerId}:${s.sessionId}:${s.sourcePath ?? ""}`;

  const toggleExpand = async (s: SessionMeta) => {
    const request = ++messageRequest.current;
    const key = sessionKey(s);
    if (expandedKey === key) {
      setExpandedKey(null);
      setMessages(null);
      return;
    }
    setExpandedKey(key);
    setMessagesLoading(true);
    setMessages(null);
    try {
      const next = await api.getSessionMessages(s.providerId, s.sourcePath ?? "");
      if (messageRequest.current === request) setMessages(next);
    } catch (err) {
      if (messageRequest.current === request) { handleError(err); setMessages(null); }
    } finally {
      if (messageRequest.current === request) setMessagesLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.deleteSession(
        pendingDelete.providerId,
        pendingDelete.sessionId,
        pendingDelete.sourcePath ?? "",
      );
      setPendingDelete(null);
      if (sessions) {
        setSessions(sessions.filter((s) => sessionKey(s) !== sessionKey(pendingDelete)));
      }
      if (expandedKey === sessionKey(pendingDelete)) {
        messageRequest.current += 1;
        setMessagesLoading(false);
        setExpandedKey(null);
        setMessages(null);
      }
    } catch (err) {
      handleError(err);
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const activeCount = sessions?.length ?? 0;
  const selected = filtered.find((s) => sessionKey(s) === expandedKey);
  useEffect(() => {
    if (selected && window.innerWidth < 1024) detailRef.current?.scrollIntoView?.({block:"start"});
  }, [expandedKey]);

  const sessionFilters = (<div className="mb-4 flex flex-col gap-3">
        <div className="segmented-control">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setProviderFilter(p.id)}
              className={cn(
                "segmented-item flex-1 px-2.5 text-xs",
                providerFilter === p.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索会话 / 项目 / ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>);

  return (
    <div className="page-stack" id="sessions">
      <PageHeader
        title="会话"
        description="本地 CLI（Claude / Codex / Gemini）的会话记录"
        action={
          <RefreshControls
            loading={loading}
            secs={secs}
            onSecsChange={setSecs}
            onRefresh={loadSessions}
          />
        }
      />



      {error && (
        <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {(sessions === null || filtered.length === 0) && sessionFilters}
      {sessions === null ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-8 w-8" />}
          title={activeCount === 0 ? "暂无会话" : "没有匹配的会话"}
          description={
            activeCount === 0
              ? "本地尚未发现 Claude / Codex / Gemini 会话记录"
              : "换个筛选条件试试"
          }
        />
      ) : (
        <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[336px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden p-4 lg:h-[672px]">{sessionFilters}<p className="mb-4 shrink-0 px-1 text-xs text-muted-foreground">最近会话 · {filtered.length} 条</p><div aria-label="会话列表" className="max-h-[460px] min-h-0 space-y-3 overflow-y-auto overscroll-contain lg:max-h-none lg:flex-1">{filtered.map((s) => {
            const key = sessionKey(s);
            return <div key={key} className={cn("rounded-xl p-3", expandedKey === key ? "bg-accent" : "bg-background")}>
              <button className="w-full text-left" onClick={() => toggleExpand(s)} aria-expanded={expandedKey === key}>
                <p className="truncate text-sm font-medium">{s.title || "（无标题）"}</p>
                <p className="mt-2 text-[11px] text-muted-foreground"><span className={NEUTRAL_TAG}>{PROVIDER_LABEL[s.providerId] ?? s.providerId}</span> · {relativeTime(s.lastActiveAt ?? s.createdAt)}</p>
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground" title={s.projectDir ?? undefined}>{s.projectDir}</p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{shortId(s.sessionId)}</p>
              </button>
              <div className="mt-2 flex justify-end gap-1">
                <Button variant="ghost" size="icon" aria-label="查看日志" onClick={() => navigate(`/logs?tab=logs&session_id=${encodeURIComponent(s.sessionId)}&session_provider=${encodeURIComponent(s.providerId)}`)}><ScrollText /></Button>
                <Button variant="ghost" size="icon" aria-label="删除会话" className="text-muted-foreground hover:text-destructive" onClick={() => setPendingDelete(s)}><Trash2 /></Button>
              </div>
            </div>;
          })}</div></Card>
          <Card ref={detailRef} aria-label="会话详情" className="flex min-h-[400px] min-w-0 flex-col gap-5 overflow-hidden p-6 lg:h-[672px]">
            {!selected ? <EmptyState icon={<MessagesSquare className="h-7 w-7" />} title="选择一个会话" description="在左侧选择会话，查看消息时间线与工具调用。" /> : <>
              <div className="flex shrink-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h2 className="break-words text-[17px] font-semibold">{selected.title || "（无标题）"}</h2><p className="mt-2 text-xs text-muted-foreground">{PROVIDER_LABEL[selected.providerId] ?? selected.providerId} · {(selected.projectDir ?? "").split(/[\\/]/).filter(Boolean).pop() || "本地项目"} · {selected.lastActiveAt || selected.createdAt ? formatTime(selected.lastActiveAt ?? selected.createdAt!) : "时间未知"}</p></div><Button variant="outline" size="sm" onClick={() => navigate(`/logs?tab=logs&session_id=${encodeURIComponent(selected.sessionId)}&session_provider=${encodeURIComponent(selected.providerId)}`)}>查看关联日志</Button></div>
              <p aria-label="会话项目路径" className="shrink-0 break-all font-mono text-xs text-muted-foreground">{selected.projectDir || "未提供项目路径"}</p>
              {messagesLoading ? <LoadingState /> : messages ? <Suspense fallback={<LoadingState />}><SessionReader key={sessionKey(selected)} messages={messages} resumeCommand={selected.resumeCommand}/></Suspense> : <EmptyState title="无消息内容" />}
              <p className="shrink-0 text-[11px] text-muted-foreground">内容读取自本地 CLI 会话文件；删除本地会话前需再次确认。</p>
            </>}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        title="删除会话"
        message={
          pendingDelete
            ? `确定删除 ${PROVIDER_LABEL[pendingDelete.providerId] ?? pendingDelete.providerId} 会话「${
                pendingDelete.title || pendingDelete.sessionId
              }」？该操作会删除本地会话文件，不可恢复。`
            : ""
        }
        confirmText="删除"
        variant="destructive"
        onConfirm={confirmDelete}
        pending={deleting}
      />
    </div>
  );
}
