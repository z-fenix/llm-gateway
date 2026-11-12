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
import { Switch } from "../components/ui/switch";
import SegmentedControl from "../components/SegmentedControl";
import ErrorBanner from "../components/ErrorBanner";
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
    <div className="page-stack" id="channels">
      <PageHeader title="渠道管理" description="连接上游服务，配置调度优先级与模型映射。" action={<Button onClick={openCreate}><Plus />新建渠道</Button>} />
      {error && <ErrorBanner message={error} onRetry={load} />}
      <div className="page-toolbar">
        <div className="relative w-full sm:max-w-[400px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchInputRef} className="pl-9" placeholder="搜索名称 / 供应商 / Base URL / 模型" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <SegmentedControl value={statusFilter} options={STATUS_OPTIONS} label="渠道状态" onChange={setStatusFilter} />
      </div>
      {list.length === 0 ? <EmptyState title="暂无渠道" description="还没有配置任何上游渠道，先创建一个吧"><Button onClick={openCreate}><Plus />新建渠道</Button></EmptyState> : filtered.length === 0 ? <EmptyState title="没有匹配的渠道" description="换个搜索词或筛选条件试试" /> : (
        <div className="table-shell">
          <table className="data-table min-w-[980px]">
            <thead><tr><th>渠道</th><th>上游协议</th><th>优先级 / 权重</th><th>支持模型</th><th>调用 / 平均延迟</th><th>启用</th><th className="text-right">操作</th></tr></thead>
            <tbody>{filtered.map((c) => <tr key={c.id}>
              <td><div className="max-w-[250px]"><p className="truncate font-medium" title={c.name}>{c.name}</p><p className="mt-1.5 truncate text-[11px] text-muted-foreground" title={c.base_url}>{c.base_url}</p></div></td>
              <td><Badge variant="secondary">{c.upstream_protocol}</Badge><p className="mt-1.5 text-[11px] text-muted-foreground">{c.supplier}</p></td>
              <td className="tabular-nums">{c.priority} / {c.weight}</td>
              <td><span title={c.models.join(", ")} className="cursor-help text-muted-foreground">{c.models.length} 个模型</span></td>
              <td className="tabular-nums"><p>{c.total_calls.toLocaleString()} / {c.avg_latency_ms} ms</p><p className="mt-1.5 text-[11px] text-muted-foreground">成功率 {(c.success_rate * 100).toFixed(1)}% · {c.total_tokens.toLocaleString()} Token</p></td>
              <td><Switch checked={c.enabled} aria-label={`启用 ${c.name}`} onCheckedChange={(enabled) => { void api.updateChannel({ ...c, enabled }).then(load).catch(handleError); }} /></td>
              <td><div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" aria-label="连通检测" onClick={() => test(c.id)} disabled={testingId === c.id}>{testingId === c.id ? <Loader2 className="animate-spin" /> : <Activity />}测试</Button>
                <Button variant="ghost" size="icon" aria-label="编辑" title="编辑" onClick={() => openEdit(c)}><Edit /></Button>
                <Button variant="ghost" size="icon" aria-label="复制" title="复制渠道" onClick={() => duplicate(c)}><Copy /></Button>
                <Button variant="ghost" size="icon" aria-label="删除" title="删除" onClick={() => setDeleteTarget(c)} className="text-muted-foreground hover:text-destructive"><Trash2 /></Button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="page-toolbar text-xs text-muted-foreground"><span>共 {list.length} 个渠道 · {list.filter((c) => c.enabled).length} 个已启用</span><span>Ctrl + F 搜索</span></div>
      <div className="info-banner"><Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><h2 className="font-medium">调度如何选择渠道？</h2><p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">优先级高的渠道先尝试；同优先级按权重分配。角色命中时优先使用该角色的专属路由。</p></div></div>
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditing(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>{editing ? "编辑渠道" : "新建渠道"}</DialogTitle><DialogDescription>{editing ? "修改渠道信息并保存" : "配置上游服务；保存后可在列表测试连通性。"}</DialogDescription></DialogHeader>
          {error && <ErrorBanner message={error} />}
          <ChannelForm initial={editing ?? undefined} onSubmit={save} onCancel={() => setDialogOpen(false)} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={Boolean(deleteTarget)} title="删除渠道" message={deleteTarget ? `确定删除渠道「${deleteTarget.name}」?关联的角色路由与兜底引用可能失效。` : undefined} variant="destructive" onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} />
    </div>
  );
}
