import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, KeyRound, Plus } from "lucide-react";
import { api } from "../lib/api";
import { formatTokenAmount, formatTokenInput, parseTokenAmount } from "../lib/tokenUnits";
import { useFormValidation } from "../lib/useFormValidation";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";
import type { ApiKey } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";

const QUOTA_HELP = "支持 K / M / B / T、万 / 亿，如 1.5M；留空不限。";
const QUOTA_ERROR = "请输入非负整数或有效单位，如 1.5M（不超过安全整数）";
const masked = (key: string) => `${key.match(/^(?:sk-lgw-|lgw_)/)?.[0] ?? ""}••••••••${key.length > 8 ? key.slice(-4) : ""}`;

export default function ApiKeysPage() {
  const [list, setList] = useState<ApiKey[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editQuota, setEditQuota] = useState("");
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const [pending, setPending] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const createValidation = useFormValidation({ name: name.trim() ? undefined : "名称不能为空", quota: parseTokenAmount(quota) === "invalid" ? QUOTA_ERROR : undefined });
  const editValidation = useFormValidation({ name: editName.trim() ? undefined : "名称不能为空", quota: parseTokenAmount(editQuota) === "invalid" ? QUOTA_ERROR : undefined });

  const handleError = (err: unknown) => {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    toast.error(message);
  };
  const load = () => { setError(null); api.listApiKeys().then(setList).catch(handleError); };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const q = parseTokenAmount(quota);
    if (pending || createValidation.invalid || q === "invalid") return;
    setError(null);
    setPending(true);
    try {
      await api.createApiKey(name.trim(), q);
      setName(""); setQuota(""); setCreateOpen(false); createValidation.reset();
      toast.success("密钥已生成"); load();
    } catch (err) { handleError(err); } finally { setPending(false); }
  };
  const openEdit = (key: ApiKey) => {
    editValidation.reset(); setError(null); setEditing(key); setEditName(key.name);
    setEditQuota(formatTokenInput(key.quota_total)); setRevealed(false);
  };
  const closeEdit = () => { if (!pending) { setEditing(null); setRevealed(false); } };
  const saveEdit = async () => {
    const q = parseTokenAmount(editQuota);
    if (!editing || pending || editValidation.invalid || q === "invalid") return;
    setError(null); setPending(true);
    try {
      await api.updateApiKey(editing.id, editName.trim(), q);
      setEditing(null); setRevealed(false); toast.success("密钥已更新"); load();
    } catch (err) { handleError(err); } finally { setPending(false); }
  };
  const toggleEnabled = async (key: ApiKey) => {
    if (toggling.has(key.id)) return;
    setToggling(ids => new Set(ids).add(key.id));
    try {
      await api.setApiKeyEnabled(key.id, !key.enabled);
      toast.success(key.enabled ? "已禁用" : "已启用"); load();
    } catch (err) { handleError(err); } finally {
      setToggling(ids => { const next = new Set(ids); next.delete(key.id); return next; });
    }
  };
  const copyKey = async (key: ApiKey) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(key.key);
      else {
        const input = document.createElement("textarea"); input.value = key.key;
        document.body.appendChild(input); input.select();
        try { document.execCommand("copy"); } finally { input.remove(); }
      }
      toast.success("已复制");
    } catch (err) { handleError(err); }
  };
  const confirmDelete = async () => {
    if (!deleting || pending) return;
    setPending(true);
    try {
      await api.deleteApiKey(deleting.id);
      if (editing?.id === deleting.id) { setEditing(null); setRevealed(false); }
      setDeleting(null); toast.success("密钥已删除"); load();
    } catch (err) { handleError(err); } finally { setPending(false); }
  };
  const totalTokens = list.reduce((n, key) => n + key.total_tokens, 0);

  return (
    <div className="page-stack" id="api-keys">
      <PageHeader title="API 密钥" description="为本地开发工具分配访问凭据，控制 Token 配额与启用状态。" action={<Button onClick={() => { createValidation.reset(); setCreateOpen(true); }}><Plus />创建密钥</Button>} />
      {error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      <dl className="grid grid-cols-1 gap-6 sm:grid-cols-3" aria-label="密钥摘要">
        {[["密钥总数", list.length], ["已启用", list.filter(k => k.enabled).length], ["累计 Token", formatTokenAmount(totalTokens)]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd title={label === "累计 Token" ? totalTokens.toLocaleString() : undefined} className="mt-2 text-[28px] font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
      <div className="info-banner"><KeyRound className="h-4 w-4 shrink-0 text-primary" /><p>密钥默认隐藏；在管理中复制或查看。请勿将密钥放入代码仓库或共享截图。</p></div>
      <Dialog open={createOpen} onOpenChange={open => !pending && setCreateOpen(open)}>
        <DialogContent>
          <DialogHeader><DialogTitle>新建密钥</DialogTitle><DialogDescription>生成新的访问密钥，可设置 Token 配额。</DialogDescription></DialogHeader>
          <DialogBody className="space-y-5">
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <FormField label="名称" htmlFor="key-name" error={createValidation.errors.name}><Input id="key-name" onBlur={() => createValidation.touch("name")} aria-invalid={!!createValidation.errors.name} placeholder="用户/应用名" value={name} onChange={e => setName(e.target.value)} /></FormField>
            <FormField label="Token 配额" htmlFor="key-quota" error={createValidation.errors.quota}><Input id="key-quota" onBlur={() => createValidation.touch("quota")} aria-invalid={!!createValidation.errors.quota} aria-describedby="key-quota-help" placeholder="Token 配额（留空不限）" value={quota} onChange={e => setQuota(e.target.value)} /><p id="key-quota-help" className="text-xs text-muted-foreground">{QUOTA_HELP}</p></FormField>
          </DialogBody>
          <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setCreateOpen(false)}>取消</Button><Button onClick={create} disabled={pending || createValidation.invalid}><Plus />{pending ? "生成中…" : "生成密钥"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {list.length === 0 ? <EmptyState title="暂无密钥" description="还没有生成任何 API 密钥，先创建一个吧"><Button onClick={() => setCreateOpen(true)}>新建密钥</Button></EmptyState> : (
        <div className="table-shell">
          <table className="data-table min-w-[880px]">
            <thead><tr><th>名称 / 最近使用</th><th className="w-[230px]">API 密钥</th><th className="w-[200px]">Token 用量 / 配额</th><th className="w-[100px]">启用</th><th className="w-[160px]">操作</th></tr></thead>
            <tbody>{list.map(key => {
              const remaining = key.quota_total === null ? null : key.quota_total - key.quota_used;
              return <tr key={key.id} className="h-[72px]">
                <td><p className="font-medium">{key.name}</p><p className="mt-1.5 text-[11px] text-muted-foreground">{key.last_used_at == null ? "尚未使用" : new Date(key.last_used_at * 1000).toLocaleString()}</p></td>
                <td className="font-mono text-xs text-muted-foreground">{masked(key.key)}</td>
                <td title={`${key.quota_used.toLocaleString()} / ${key.quota_total?.toLocaleString() ?? "不限"}`}><p className="tabular-nums">{formatTokenAmount(key.quota_used)} / {key.quota_total === null ? "不限" : formatTokenAmount(key.quota_total)}</p><p className={`mt-1.5 text-[11px] ${remaining !== null && remaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>{remaining === null ? "不限制用量" : remaining < 0 ? `已超出 ${formatTokenAmount(-remaining)}` : `剩余 ${formatTokenAmount(remaining)}`}</p></td>
                <td><Switch checked={key.enabled} disabled={toggling.has(key.id)} onCheckedChange={() => void toggleEnabled(key)} aria-label={`启用 ${key.name}`} /></td>
                <td><Button variant="outline" size="sm" onClick={() => openEdit(key)}>管理密钥</Button></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      <Card className="space-y-3 p-6"><h2 className="text-base font-semibold">一个工具，一枚密钥</h2><p className="text-[13px] text-muted-foreground">分别创建密钥可独立查看调用记录与配额；停用密钥不影响其他工具连接。</p><a href="#/settings?section=cli" className="inline-flex rounded-full border border-input px-4 py-2 text-xs font-medium hover:bg-muted">前往 CLI 接入配置</a></Card>
      <Dialog open={editing !== null} onOpenChange={open => !open && closeEdit()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>管理密钥</DialogTitle><DialogDescription>查看使用情况，修改名称与 Token 配额。</DialogDescription></DialogHeader>
          <DialogBody className="space-y-5">
            {editing && <>
              <div className="space-y-3 rounded-xl bg-background p-4"><p className="break-all font-mono text-xs">{revealed ? editing.key : masked(editing.key)}</p><div className="flex gap-2"><Button variant="outline" size="sm" aria-label={`${revealed ? "隐藏" : "查看"} ${editing.name} 密钥`} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff /> : <Eye />}{revealed ? "隐藏密钥" : "查看密钥"}</Button><Button variant="outline" size="sm" onClick={() => void copyKey(editing)}><Copy />复制密钥</Button></div></div>
              <dl className="grid grid-cols-2 gap-4 text-xs"><div><dt className="text-muted-foreground">累计调用</dt><dd className="mt-2 text-lg tabular-nums">{editing.total_calls.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">累计 Token</dt><dd title={editing.total_tokens.toLocaleString()} className="mt-2 text-lg tabular-nums">{formatTokenAmount(editing.total_tokens)}</dd></div></dl>
              <FormField label="名称" htmlFor="edit-name" error={editValidation.errors.name}><Input id="edit-name" onBlur={() => editValidation.touch("name")} aria-invalid={!!editValidation.errors.name} placeholder="用户/应用名" value={editName} onChange={e => setEditName(e.target.value)} /></FormField>
              <FormField label="Token 配额" htmlFor="edit-quota" error={editValidation.errors.quota}><Input id="edit-quota" onBlur={() => editValidation.touch("quota")} aria-invalid={!!editValidation.errors.quota} aria-describedby="edit-quota-help" placeholder="Token 配额（留空不限）" value={editQuota} onChange={e => setEditQuota(e.target.value)} /><p id="edit-quota-help" className="text-xs text-muted-foreground">{QUOTA_HELP}</p></FormField>
              <div className="flex items-center justify-between gap-4 border-t border-border pt-4"><p className="text-xs text-muted-foreground">删除后，使用此密钥的调用将失效。</p><Button variant="outline" size="sm" disabled={pending} className="shrink-0 text-destructive" onClick={() => setDeleting(editing)}>删除密钥</Button></div>
            </>}
          </DialogBody>
          <FormFooter onCancel={closeEdit} onSubmit={saveEdit} busy={pending} submitDisabled={editValidation.invalid} />
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={deleting !== null} title="删除密钥" message={deleting ? `确定删除密钥「${deleting.name}」吗？使用该密钥的调用将立即失效。` : undefined} pending={pending} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
    </div>
  );
}
