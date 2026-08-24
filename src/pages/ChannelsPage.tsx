import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  Edit3,
  Plus,
  Search,
  Server,
  TestTube,
  Trash2,
} from "lucide-react";
import { api } from "../lib/api";
import type { Channel } from "../types";
import ChannelForm from "../components/ChannelForm";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import ConfirmDialog from "../components/ConfirmDialog";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

const STATUS_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "启用", value: "enabled" },
  { label: "禁用", value: "disabled" },
];

function protocolBadgeVariant(protocol: string): string {
  if (protocol.includes("openai")) return "bg-blue-100 text-blue-700";
  if (protocol.includes("anthropic")) return "bg-purple-100 text-purple-700";
  if (protocol.includes("gemini")) return "bg-teal-100 text-teal-700";
  return "bg-muted text-muted-foreground";
}

function supplierInitials(supplier: string): string {
  return supplier.slice(0, 2).toUpperCase();
}

function supplierGradient(supplier: string): string {
  const s = supplier.toLowerCase();
  if (s.includes("openai")) return "from-blue-500 to-cyan-400";
  if (s.includes("anthropic") || s.includes("claude")) return "from-purple-500 to-indigo-400";
  if (s.includes("google") || s.includes("gemini")) return "from-teal-500 to-emerald-400";
  if (s.includes("azure")) return "from-sky-600 to-blue-500";
  if (s.includes("deepseek")) return "from-slate-600 to-slate-400";
  return "from-muted to-muted-foreground";
}

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => {
    setError(null);
    api.listChannels().then(setList).catch(handleError);
  };
  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (c: Channel) => {
    setEditing(c);
    setDialogOpen(true);
  };

  const save = async (c: Channel) => {
    setError(null);
    try {
      if (c.id) await api.updateChannel(c);
      else await api.createChannel(c);
      setDialogOpen(false);
      setEditing(null);
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const duplicate = async (c: Channel) => {
    setError(null);
    try {
      await api.duplicateChannel(c.id);
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const test = async (id: string) => {
    setError(null);
    try {
      const r = await api.testChannel(id);
      setTestMsg((m) => ({
        ...m,
        [id]: r.ok ? `✓ ${r.latency_ms}ms` : `✗ ${r.error}`,
      }));
    } catch (err) {
      handleError(err);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setError(null);
    try {
      await api.deleteChannel(deleteTarget.id);
      setDeleteTarget(null);
      load();
    } catch (err) {
      setDeleteTarget(null);
      handleError(err);
    }
  };

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return list.filter((c) => {
      if (statusFilter === "enabled" && !c.enabled) return false;
      if (statusFilter === "disabled" && c.enabled) return false;
      if (!kw) return true;
      return (
        c.name.toLowerCase().includes(kw) ||
        c.supplier.toLowerCase().includes(kw) ||
        c.base_url.toLowerCase().includes(kw) ||
        c.models.some((m) => m.toLowerCase().includes(kw))
      );
    });
  }, [list, keyword, statusFilter]);

  return (
    <div>
      <PageHeader
        title="渠道管理"
        description="配置上游渠道、优先级权重与模型映射"
        action={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            新建渠道
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑渠道" : "新建渠道"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "修改渠道信息并保存"
                : "填写上游渠道信息，保存后即可开始转发请求"}
            </DialogDescription>
          </DialogHeader>
          <ChannelForm
            initial={editing ?? undefined}
            onSubmit={save}
            onCancel={() => setDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索名称 / 供应商 / Base URL / 模型"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1 rounded-xl border bg-card p-1">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              onClick={() => setStatusFilter(s.value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                statusFilter === s.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          title="暂无渠道"
          description="还没有配置任何上游渠道，先创建一个吧"
        >
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            新建渠道
          </Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的渠道"
          description="换个搜索词或筛选条件试试"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => (
            <div
              key={c.id}
              className={cn(
                "flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md",
                !c.enabled && "opacity-75"
              )}
            >
              <div className="mb-3 flex items-start gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-xs font-bold text-white",
                    supplierGradient(c.supplier)
                  )}
                >
                  {supplierInitials(c.supplier)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-semibold text-foreground">
                      {c.name}
                    </h3>
                    <Badge variant={c.enabled ? "default" : "secondary"}>
                      {c.enabled ? "启用" : "禁用"}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="font-normal">
                      {c.supplier}
                    </Badge>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-xs font-medium",
                        protocolBadgeVariant(c.upstream_protocol)
                      )}
                    >
                      {c.upstream_protocol}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-muted-foreground" title={c.base_url}>
                    {c.base_url}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-xs">优先级</span>
                  <span className="font-medium text-foreground">{c.priority}</span>
                  <span className="text-xs">权重</span>
                  <span className="font-medium text-foreground">{c.weight}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {c.models.map((m) => (
                    <Badge
                      key={m}
                      variant="outline"
                      className="font-mono text-xs font-normal"
                    >
                      {m}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-3 text-xs">
                <div>
                  <div className="text-muted-foreground">调用</div>
                  <div className="font-medium text-foreground">{c.total_calls}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Token</div>
                  <div className="font-medium text-foreground">
                    {c.total_tokens.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">成功率</div>
                  <div className="font-medium text-foreground">
                    {(c.success_rate * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1"
                  onClick={() => openEdit(c)}
                >
                  <Edit3 className="mr-1 h-3.5 w-3.5" />
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1"
                  onClick={() => duplicate(c)}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  复制
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1"
                  onClick={() => test(c.id)}
                >
                  <TestTube className="mr-1 h-3.5 w-3.5" />
                  测试
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label="删除"
                  onClick={() => setDeleteTarget(c)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {testMsg[c.id] && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {testMsg[c.id]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除渠道"
        message={
          deleteTarget
            ? `确定删除渠道「${deleteTarget.name}」?关联的角色路由与兜底引用可能失效。`
            : undefined
        }
        variant="destructive"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
