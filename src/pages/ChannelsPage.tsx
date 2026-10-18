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
import { NEUTRAL_TAG } from "../lib/tagStyles";
import type { Channel } from "../types";
import ChannelForm from "../components/ChannelForm";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import ConfirmDialog from "../components/ConfirmDialog";
import { Input } from "../components/ui/input";
import { SegmentedTabs } from "../components/SegmentedTabs";
import { cn } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export const STATUS_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "启用", value: "enabled" },
  { label: "禁用", value: "disabled" },
];

function supplierInitials(supplier: string): string {
  return supplier.slice(0, 2).toUpperCase();
}

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Channel | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  // 最近一次连通检测的实测延迟（毫秒），按渠道 id 记录
  const [latencies, setLatencies] = useState<Record<string, number>>({});
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
        setLatencies((prev) => ({ ...prev, [id]: r.latency_ms }));
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

      {/* 状态筛选 —— SegmentedTabs，跟随 cc-switch 供应商列表顶部布局 */}
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
        <SegmentedTabs
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_OPTIONS}
          ariaLabel="渠道状态筛选"
        />
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
                lastLatencyMs={latencies[c.id]}
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
  lastLatencyMs,
  onEdit,
  onDuplicate,
  onTest,
  onDelete,
  testingId,
}: {
  channel: Channel;
  lastLatencyMs?: number;
  onEdit: () => void;
  onDuplicate: () => void;
  onTest: () => void;
  onDelete: () => void;
  testingId: string | null;
}) {
  const isTesting = testingId === channel.id;
  // 延迟常驻：优先最近一次实测值，其次统计口径的平均延迟
  const latencyMs = lastLatencyMs ?? (channel.avg_latency_ms > 0 ? channel.avg_latency_ms : null);

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border p-4 transition-all duration-300",
        "bg-card text-card-foreground",
        "hover:border-primary/40 hover:shadow-sm",
        !channel.enabled && "opacity-55"
      )}
    >
      <div className="relative flex items-center gap-4">
        {/* 左侧图标：中性底色，不再按供应商着色 */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-xs font-bold text-muted-foreground">
          {supplierInitials(channel.supplier)}
        </div>

        {/* 中间信息区 */}
        <div className="min-w-0 flex-1 space-y-1">
          {/* 第一行：名称 + 状态点/已停用 + 协议 + 供应商 + 模型 */}
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="truncate font-semibold text-foreground">
              {channel.name}
            </h3>
            {channel.enabled ? (
              <span
                className="inline-flex items-center gap-1.5 shrink-0"
                title="启用"
                aria-label="启用"
              >
                <span className="h-2 w-2 rounded-full bg-success" />
                {latencyMs != null && (
                  <span className="font-mono text-xs text-success tabular-nums">
                    {latencyMs}ms
                  </span>
                )}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">已停用</span>
            )}
            <span className={NEUTRAL_TAG}>{channel.upstream_protocol}</span>
            <span className={NEUTRAL_TAG}>{channel.supplier}</span>
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
            <span className="font-mono text-muted-foreground truncate" title={channel.base_url}>
              {channel.base_url}
            </span>
            <div className="text-right text-[11px] text-muted-foreground tabular-nums shrink-0 ml-3 flex-shrink-0">
              调用 {channel.total_calls} · Token {channel.total_tokens.toLocaleString()} · 成功率 {(channel.success_rate * 100).toFixed(1)}%
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
            className={cn("h-8 w-8 p-1", !isTesting && "hover:text-success")}
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
