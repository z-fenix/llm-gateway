import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Search, Trash2, ScrollText } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { SessionMeta, SessionMessage } from "../types";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import LoadingState from "../components/LoadingState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

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

function providerBadgeVariant(provider: string): "default" | "secondary" | "outline" {
  switch (provider) {
    case "claude":
      return "default";
    case "codex":
      return "secondary";
    default:
      return "outline";
  }
}

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

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  switch (role) {
    case "user":
      return "default";
    case "assistant":
      return "secondary";
    case "tool":
      return "outline";
    default:
      return "outline";
  }
}

function messageRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "tool":
      return "工具";
    default:
      return role;
  }
}

export default function SessionsPage() {
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
      setMessages(await api.getSessionMessages(s.providerId, s.sourcePath ?? ""));
    } catch (err) {
      handleError(err);
      setMessages(null);
    } finally {
      setMessagesLoading(false);
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

  return (
    <div>
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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border bg-card p-1">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setProviderFilter(p.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                providerFilter === p.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索标题 / 项目目录 / 会话 ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

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
        <div className="space-y-2">
          {filtered.map((s) => {
            const key = sessionKey(s);
            const expanded = expandedKey === key;
            return (
              <Card key={key} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex w-full items-center">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40"
                      onClick={() => toggleExpand(s)}
                    >
                      <Badge variant={providerBadgeVariant(s.providerId)}>
                        {PROVIDER_LABEL[s.providerId] ?? s.providerId}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">
                          {s.title || "（无标题）"}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {s.projectDir && (
                            <span className="truncate font-mono">{s.projectDir}</span>
                          )}
                          <span className="font-mono">{shortId(s.sessionId)}</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>{relativeTime(s.lastActiveAt ?? s.createdAt)}</div>
                        {s.lastActiveAt ? (
                          <div className="font-mono">{formatTime(s.lastActiveAt)}</div>
                        ) : null}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="查看日志"
                      className="mr-2 shrink-0 text-muted-foreground hover:text-primary"
                      onClick={() =>
                        navigate(
                          `/logs?session_id=${encodeURIComponent(s.sessionId)}&session_provider=${encodeURIComponent(s.providerId)}`
                        )
                      }
                    >
                      <ScrollText className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="删除会话"
                      className="mr-2 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setPendingDelete(s)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {expanded && (
                    <div className="border-t px-4 py-3">
                      {messagesLoading ? (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                          加载中…
                        </div>
                      ) : messages && messages.length > 0 ? (
                        <div className="space-y-3">
                          {messages.map((m, i) => (
                            <div key={i} className="text-sm">
                              <div className="mb-1 flex items-center gap-2">
                                <Badge variant={roleBadgeVariant(m.role)}>
                                  {messageRoleLabel(m.role)}
                                </Badge>
                                {m.ts ? (
                                  <span className="text-xs text-muted-foreground">
                                    {formatTime(m.ts)}
                                  </span>
                                ) : null}
                              </div>
                              <div className="whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-foreground/90">
                                {m.content}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                          无消息内容
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
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
