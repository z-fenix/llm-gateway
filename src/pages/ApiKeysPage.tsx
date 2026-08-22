import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, Plus } from "lucide-react";
import { api } from "../lib/api";
import type { ApiKey } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

type QuotaParse = number | null | "invalid";

export default function ApiKeysPage() {
  const [list, setList] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editQuota, setEditQuota] = useState("");
  const [editOpen, setEditOpen] = useState(false);

  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const [pending, setPending] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => {
    setError(null);
    api.listApiKeys().then(setList).catch(handleError);
  };
  useEffect(() => {
    load();
  }, []);

  const parseQuota = (raw: string): QuotaParse => {
    const q = raw.trim();
    if (!q) return null;
    const n = Number(q);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return n;
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const q = parseQuota(quota);
    if (q === "invalid") {
      setError("请输入非负数字");
      return;
    }
    setError(null);
    try {
      await api.createApiKey(trimmed, q);
      setName("");
      setQuota("");
      toast.success("密钥已生成");
      load();
    } catch (err) {
      handleError(err);
    }
  };

  const openEdit = (k: ApiKey) => {
    setEditing(k);
    setEditName(k.name);
    setEditQuota(k.quota_total === null ? "" : String(k.quota_total));
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      // 页面级 error 横幅位于 Dialog 遮罩之下，用户在弹窗内看不到；改用 toast 在弹窗上方提示
      toast.error("名称不能为空");
      return;
    }
    const q = parseQuota(editQuota);
    if (q === "invalid") {
      toast.error("请输入非负数字");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await api.updateApiKey(editing.id, trimmed, q);
      setEditOpen(false);
      setEditing(null);
      toast.success("密钥已更新");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const toggleEnabled = (k: ApiKey) => {
    setError(null);
    api
      .setApiKeyEnabled(k.id, !k.enabled)
      .then(() => {
        toast.success(k.enabled ? "已禁用" : "已启用");
        load();
      })
      .catch(handleError);
  };

  const copyKey = async (k: ApiKey) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(k.key);
      } else {
        const ta = document.createElement("textarea");
        ta.value = k.key;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success("已复制");
    } catch (err) {
      handleError(err);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteApiKey(deleting.id);
      setDeleting(null);
      toast.success("密钥已删除");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="API 密钥"
        description="管理本地网关的 API 密钥：创建、配额、启用状态与复制"
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            新建密钥
          </CardTitle>
          <CardDescription>
            生成新的访问密钥，可设置 Token 配额（留空不限）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[220px] space-y-1.5">
              <Label htmlFor="key-name">名称</Label>
              <Input
                id="key-name"
                placeholder="用户/应用名"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="min-w-[220px] space-y-1.5">
              <Label htmlFor="key-quota">Token 配额</Label>
              <Input
                id="key-quota"
                placeholder="Token 配额（留空不限）"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </div>
            <Button onClick={create} disabled={!name.trim()}>
              <Plus className="h-4 w-4" />
              生成密钥
            </Button>
          </div>
        </CardContent>
      </Card>

      {list.length === 0 ? (
        <EmptyState
          title="暂无密钥"
          description="还没有生成任何 API 密钥，先创建一个吧"
        >
          <Button onClick={() => nameRef.current?.focus()}>新建密钥</Button>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">密钥</th>
                <th className="px-4 py-3 font-medium">配额(已用/总量)</th>
                <th className="px-4 py-3 font-medium">调用</th>
                <th className="px-4 py-3 font-medium">Token</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((k) => (
                <tr
                  key={k.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {k.name}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      {k.key}
                    </span>
                    <button
                      className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                      onClick={() => copyKey(k)}
                      title="复制密钥"
                    >
                      <Copy className="h-3 w-3" />
                      复制
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {k.quota_used}/{k.quota_total ?? "∞"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {k.total_calls}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {k.total_tokens}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={k.enabled ? "default" : "secondary"}>
                      {k.enabled ? "启用" : "禁用"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => openEdit(k)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-primary hover:underline"
                        onClick={() => toggleEnabled(k)}
                      >
                        {k.enabled ? "禁用" : "启用"}
                      </button>
                      <button
                        className="text-destructive hover:underline"
                        onClick={() => setDeleting(k)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={editOpen}
        onOpenChange={(next) => {
          if (!next) {
            setEditOpen(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>编辑密钥</DialogTitle>
            <DialogDescription>修改名称与 Token 配额后保存</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">名称</Label>
              <Input
                id="edit-name"
                placeholder="用户/应用名"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-quota">Token 配额</Label>
              <Input
                id="edit-quota"
                placeholder="Token 配额（留空不限）"
                value={editQuota}
                onChange={(e) => setEditQuota(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={saveEdit} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="删除密钥"
        message={
          deleting
            ? `确定删除密钥「${deleting.name}」吗？使用该密钥的调用将立即失效。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
