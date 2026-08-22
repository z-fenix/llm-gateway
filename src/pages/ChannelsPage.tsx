import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Channel } from "../types";
import ChannelForm from "../components/ChannelForm";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

export default function ChannelsPage() {
  const [list, setList] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => { setError(null); api.listChannels().then(setList).catch(handleError); };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (c: Channel) => { setEditing(c); setDialogOpen(true); };

  const save = async (c: Channel) => {
    setError(null);
    try {
      if (c.id) await api.updateChannel(c); else await api.createChannel(c);
      setDialogOpen(false);
      setEditing(null);
      load();
    } catch (err) {
      handleError(err);
    }
  };
  const test = async (id: string) => {
    setError(null);
    try {
      const r = await api.testChannel(id);
      setTestMsg((m) => ({ ...m, [id]: r.ok ? `✓ ${r.latency_ms}ms` : `✗ ${r.error}` }));
    } catch (err) {
      handleError(err);
    }
  };

  return (
    <div>
      <PageHeader
        title="渠道管理"
        description="配置上游渠道、优先级权重与模型映射"
        action={<Button onClick={openCreate}>新建渠道</Button>}
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑渠道" : "新建渠道"}</DialogTitle>
            <DialogDescription>
              {editing ? "修改渠道信息并保存" : "填写上游渠道信息，保存后即可开始转发请求"}
            </DialogDescription>
          </DialogHeader>
          <ChannelForm initial={editing ?? undefined} onSubmit={save} onCancel={() => setDialogOpen(false)} />
        </DialogContent>
      </Dialog>

      {list.length === 0 ? (
        <EmptyState
          title="暂无渠道"
          description="还没有配置任何上游渠道，先创建一个吧"
        >
          <Button onClick={openCreate}>新建渠道</Button>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">供应商</th>
                <th className="px-4 py-3 font-medium">上游协议</th>
                <th className="px-4 py-3 font-medium">Base URL</th>
                <th className="px-4 py-3 font-medium">优先级/权重</th>
                <th className="px-4 py-3 font-medium">模型</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3 font-medium text-foreground">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.supplier}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.upstream_protocol}</td>
                  <td className="max-w-[180px] truncate px-4 py-3 text-muted-foreground">{c.base_url}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.priority}/{c.weight}</td>
                  <td className="max-w-[160px] truncate px-4 py-3 text-muted-foreground">{c.models.join(",")}</td>
                  <td className="px-4 py-3">
                    <Badge variant={c.enabled ? "default" : "secondary"}>{c.enabled ? "启用" : "禁用"}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button className="text-primary hover:underline" onClick={() => openEdit(c)}>编辑</button>
                      <button className="text-emerald-600 hover:underline" onClick={() => test(c.id)}>测试</button>
                      <button className="text-destructive hover:underline"
                        onClick={() => { setError(null); api.deleteChannel(c.id).then(load).catch(handleError); }}>删除</button>
                      {testMsg[c.id] && <span className="text-xs text-muted-foreground">{testMsg[c.id]}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
