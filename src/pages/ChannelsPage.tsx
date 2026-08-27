import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Edit,
  Plus,
  Search,
  Activity,
  Trash2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
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
  if (protocol.includes("openai"))
    return "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300";
  if (protocol.includes("anthropic"))
    return "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300";
  if (protocol.includes("gemini"))
    return "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300";
  return "bg-slate-200 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200";
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

function supplierInitials(supplier: string): string {
  return supplier.slice(0, 2).toUpperCase();
}

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Ctrl+F / Cmd+F 打开搜索框
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsSearchOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      const frame = requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isSearchOpen]);

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
    setTestingId(id);
    try {
      const r = await api.testChannel(id);
      if (r.ok) {
        toast.success(`连通正常 · ${r.latency_ms}ms`);
      } else {
        toast.error(r.error ?? "连通失败");
      }
    } catch (err) {
      handleError(err);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingId(null);
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
    <div className="flex flex-col h-full min-h-0">
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
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* 状态筛选胶囊 —— 跟随 cc-switch 供应商列表顶部布局 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <div className="space-y-3 pt-1">
            {filtered.map((c) => (
              <ChannelCard
                key={c.id}
                channel={c}
                onEdit={() => openEdit(c)}
                onDuplicate={() => duplicate(c)}
                onTest={() => test(c.id)}
                onDelete={() => setDeleteTarget(c)}
                testingId={testingId}
              />
            ))}
          </div>
        )}
      </div>

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

function ChannelCard({
  channel,
  onEdit,
  onDuplicate,
  onTest,
  onDelete,
  testingId,
}: {
  channel: Channel;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest: () => void;
  onDelete: () => void;
  testingId: string | null;
}) {
  const isTesting = testingId === channel.id;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border p-4 transition-all duration-300",
        "bg-card text-card-foreground",
        "hover:border-border-active hover:shadow-sm",
        !channel.enabled && "opacity-65"
      )}
    >
      {/* 蓝色渐变左侧条，突出启用状态 */}
      {channel.enabled && (
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl bg-gradient-to-b from-blue-500 to-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      )}

      <div className="relative flex items-center gap-4">
        {/* 左侧图标 */}
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-gradient-to-br text-xs font-bold text-white shadow-sm transition-transform duration-300 group-hover:scale-105",
            supplierGradient(channel.supplier)
          )}
        >
          {supplierInitials(channel.supplier)}
        </div>

        {/* 中间信息区 */}
        <div className="min-w-0 flex-1 space-y-1">
          {/* 第一行：名称 + 状态 + 协议 + 模型 */}
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="truncate font-semibold text-foreground">
              {channel.name}
            </h3>
            <Badge variant={channel.enabled ? "default" : "secondary"} className="shrink-0">
              {channel.enabled ? "启用" : "禁用"}
            </Badge>
            <span
              className={cn(
                "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold shrink-0",
                protocolBadgeVariant(channel.upstream_protocol)
              )}
            >
              {channel.upstream_protocol}
            </span>
            <span className="inline-flex items-center rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-700/60 dark:text-slate-200 shrink-0">
              {channel.supplier}
            </span>
            {channel.models.map((m) => (
              <Badge
                key={m}
                variant="outline"
                className="font-mono text-[10px] font-normal shrink-0"
              >
                {m}
              </Badge>
            ))}
          </div>

          {/* 第二行：URL + 统计（统计右浮动） */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground truncate" title={channel.base_url}>
              {channel.base_url}
            </span>
            <div className="text-right text-[11px] text-muted-foreground tabular-nums shrink-0 ml-3 flex-shrink-0">
              调用 {channel.total_calls} · Token {channel.total_tokens.toLocaleString()} · 成功率 {(channel.success_rate * 100).toFixed(1)}% · 延迟 {channel.avg_latency_ms}ms
            </div>
          </div>
        </div>

        {/* 右侧操作按钮 —— hover 时显现 */}
        <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-200">
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            aria-label="编辑"
            title="编辑"
            className="h-8 w-8 p-1"
          >
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDuplicate}
            aria-label="复制"
            title="复制"
            className="h-8 w-8 p-1"
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onTest}
            disabled={isTesting}
            aria-label="连通检测"
            title="连通检测"
            className={cn("h-8 w-8 p-1", !isTesting && "hover:text-emerald-600 dark:hover:text-emerald-400")}
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            aria-label="删除"
            title="删除"
            className="h-8 w-8 p-1 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
