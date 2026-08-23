import { useEffect, useMemo, useState } from "react";
import { MessagesSquare, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { SessionMeta, SessionMessage } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

function prettyJson(s?: string | null): string {
  if (!s) return "(无内容)";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function shortTrace(trace: string): string {
  return trace.length > 16 ? `${trace.slice(0, 16)}…` : trace;
}

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function roleBadgeVariant(role: string | null): "default" | "secondary" | "destructive" | "outline" {
  switch (role?.toLowerCase()) {
    case "user":
      return "default";
    case "assistant":
      return "secondary";
    case "system":
      return "outline";
    default:
      return "outline";
  }
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingTraceId, setDeletingTraceId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleError = (err: unknown) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
  };

  const loadSessions = () => {
    setError(null);
    api.listSessions().then(setSessions).catch(handleError);
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (!selectedTraceId) {
      setMessages([]);
      setExpandedSeq(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .getSessionMessages(selectedTraceId)
      .then((res) => {
        setMessages(res);
        setExpandedSeq(null);
      })
      .catch(handleError)
      .finally(() => setLoading(false));
  }, [selectedTraceId]);

  const filteredSessions = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return sessions;
    return sessions.filter(
      (s) =>
        s.trace_id.toLowerCase().includes(kw) ||
        (s.title ?? "").toLowerCase().includes(kw)
    );
  }, [sessions, search]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.trace_id === selectedTraceId) ?? null,
    [sessions, selectedTraceId]
  );

  const confirmDelete = async () => {
    if (!deletingTraceId) return;
    setPending(true);
    setError(null);
    try {
      await api.deleteSession(deletingTraceId);
      setDeletingTraceId(null);
      setSelectedTraceId(null);
      loadSessions();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <PageHeader title="会话管理" description="按 trace_id 浏览会话消息记录" />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        <Card className="flex h-[calc(100vh-10rem)] flex-col md:h-[calc(100vh-9rem)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">会话列表</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3 pt-0">
            <Input
              placeholder="搜索 trace_id / 标题"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {filteredSessions.length === 0 ? (
              <div className="flex-1">
                <EmptyState
                  icon={<MessagesSquare className="h-8 w-8" />}
                  title="暂无会话"
                  description="当前没有可展示的会话记录"
                />
              </div>
            ) : (
              <div className="flex-1 space-y-2 overflow-auto pr-1">
                {filteredSessions.map((s) => (
                  <button
                    key={s.trace_id}
                    onClick={() => setSelectedTraceId(s.trace_id)}
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition-colors",
                      selectedTraceId === s.trace_id
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:bg-accent/50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {s.title ?? shortTrace(s.trace_id)}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {formatTime(s.last_active)}
                        </div>
                      </div>
                      <Badge variant="secondary" className="shrink-0">
                        {s.message_count}
                      </Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.roles.map(([role, count]) => (
                        <Badge
                          key={role}
                          variant="outline"
                          className="text-xs font-normal"
                        >
                          {role}: {count}
                        </Badge>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex h-[calc(100vh-10rem)] flex-col md:h-[calc(100vh-9rem)]">
          {selectedSession ? (
            <>
              <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">会话详情</CardTitle>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {selectedSession.trace_id}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    首次: {formatTime(selectedSession.first_active)} / 最近:{" "}
                    {formatTime(selectedSession.last_active)}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeletingTraceId(selectedSession.trace_id)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </Button>
              </CardHeader>
              <CardContent className="flex-1 overflow-auto pt-0">
                {loading ? (
                  <div className="text-sm text-muted-foreground">加载消息中...</div>
                ) : messages.length === 0 ? (
                  <EmptyState title="无消息" description="该会话下没有消息记录" />
                ) : (
                  <div className="space-y-2">
                    {messages.map((m) => (
                      <div
                        key={m.seq}
                        className="rounded-lg border border-border bg-card"
                      >
                        <button
                          onClick={() =>
                            setExpandedSeq(expandedSeq === m.seq ? null : m.seq)
                          }
                          className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent/50"
                        >
                          <Badge variant={roleBadgeVariant(m.role)} className="shrink-0">
                            {m.role ?? "unknown"}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-foreground">
                              {m.content ?? "(无内容)"}
                            </div>
                            {m.error && (
                              <div className="mt-1 text-xs text-destructive">
                                错误: {m.error}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-xs text-muted-foreground">
                            {formatTime(m.created_at)}
                          </div>
                        </button>
                        {expandedSeq === m.seq && (
                          <div className="border-t border-border bg-muted/30 p-3">
                            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                              <span>seq: {m.seq}</span>
                              <span>role: {m.role ?? "-"}</span>
                              <span>
                                status: {m.status_code ?? "-"}
                              </span>
                            </div>
                            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-3 text-xs">
                              {prettyJson(m.content)}
                            </pre>
                            {m.error && (
                              <div className="mt-2 text-xs text-destructive">
                                {m.error}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </>
          ) : (
            <CardContent className="flex h-full items-center justify-center">
              <EmptyState
                icon={<MessagesSquare className="h-8 w-8" />}
                title="选择左侧会话查看详情"
                description="点击会话列表中的条目以加载消息"
              />
            </CardContent>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={deletingTraceId !== null}
        title="删除会话"
        message={
          deletingTraceId
            ? `确定删除 trace_id 为 ${shortTrace(deletingTraceId)} 的会话吗？该会话下的所有消息将被一并删除，且不可恢复。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeletingTraceId(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
