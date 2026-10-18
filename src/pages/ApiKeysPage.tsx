import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, Plus } from "lucide-react";
import { api } from "../lib/api";
import type { ApiKey } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { StatusBadge } from "../components/StatusBadge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { FormField } from "../components/form/FormField";
import { FormFooter } from "../components/form/FormFooter";

type QuotaParse = number | null | "invalid";

/** 行内校验字段（名称必填、配额留空不限/须非负数字，后端为准）。 */
type KeyField = "name" | "quota";

function validateKeyForm(name: string, quota: string): Partial<Record<KeyField, string>> {
  const errs: Partial<Record<KeyField, string>> = {};
  if (!name.trim()) errs.name = "名称不能为空";
  if (parseQuotaValue(quota) === "invalid") errs.quota = "请输入非负数字";
  return errs;
}

/** 与既有 parseQuota 相同的解析规则（留空 null、非负数字、其余 invalid）。 */
function parseQuotaValue(raw: string): QuotaParse {
  const q = raw.trim();
  if (!q) return null;
  const n = Number(q);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return n;
}

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

  // DSH touched 语义：pristine 不喊错——行内错误仅「字段被触碰（blur/onChange）且无效」
  // 或「曾尝试提交」时渲染；提交按钮仍按原始校验态禁用（不受 touched 影响）。
  // 创建卡与编辑弹框各自独立 touched。
  const [touched, setTouched] = useState<Partial<Record<KeyField, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const errors = validateKeyForm(name, quota);
  const formValid = Object.keys(errors).length === 0;
  const touch = (k: KeyField) =>
    setTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const showErr = (k: KeyField) =>
    touched[k] || submitAttempted ? errors[k] : undefined;

  const [editTouched, setEditTouched] = useState<Partial<Record<KeyField, boolean>>>({});
  const [editSubmitAttempted, setEditSubmitAttempted] = useState(false);
  const editErrors = validateKeyForm(editName, editQuota);
  const editFormValid = Object.keys(editErrors).length === 0;
  const editTouch = (k: KeyField) =>
    setEditTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const showEditErr = (k: KeyField) =>
    editTouched[k] || editSubmitAttempted ? editErrors[k] : undefined;

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

  const create = async () => {
    setSubmitAttempted(true);
    if (!formValid) return; // 生成密钥已禁用，此处双保险（行内校验为准）
    const trimmed = name.trim();
    const q = parseQuotaValue(quota);
    if (q === "invalid") return; // 类型收窄（应用已禁用，不可达）
    setError(null);
    try {
      await api.createApiKey(trimmed, q);
      setName("");
      setQuota("");
      setTouched({});
      setSubmitAttempted(false);
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
    setEditTouched({});
    setEditSubmitAttempted(false);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditSubmitAttempted(true);
    if (pending) return;
    if (!editFormValid) return; // 应用已禁用，此处双保险（行内校验为准，行内错误在弹框内可见，不再走 toast）
    const trimmed = editName.trim();
    const q = parseQuotaValue(editQuota);
    if (q === "invalid") return; // 类型收窄（应用已禁用，不可达）
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
            <FormField label="名称" htmlFor="key-name" required error={showErr("name")}>
              <div className="min-w-[220px]">
                <Input
                  id="key-name"
                  placeholder="用户/应用名"
                  value={name}
                  onBlur={() => touch("name")}
                  onChange={(e) => {
                    touch("name");
                    setName(e.target.value);
                  }}
                />
              </div>
            </FormField>
            <FormField label="Token 配额" htmlFor="key-quota" error={showErr("quota")}>
              <div className="min-w-[220px]">
                <Input
                  id="key-quota"
                  placeholder="Token 配额（留空不限）"
                  value={quota}
                  onBlur={() => touch("quota")}
                  onChange={(e) => {
                    touch("quota");
                    setQuota(e.target.value);
                  }}
                />
              </div>
            </FormField>
            <Button onClick={create} disabled={!formValid}>
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
                    <StatusBadge semantic={k.enabled ? "success" : "neutral"}>
                      {k.enabled ? "启用" : "禁用"}
                    </StatusBadge>
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
            <FormField label="名称" htmlFor="edit-name" required error={showEditErr("name")}>
              <Input
                id="edit-name"
                placeholder="用户/应用名"
                value={editName}
                onBlur={() => editTouch("name")}
                onChange={(e) => {
                  editTouch("name");
                  setEditName(e.target.value);
                }}
              />
            </FormField>
            <FormField label="Token 配额" htmlFor="edit-quota" error={showEditErr("quota")}>
              <Input
                id="edit-quota"
                placeholder="Token 配额（留空不限）"
                value={editQuota}
                onBlur={() => editTouch("quota")}
                onChange={(e) => {
                  editTouch("quota");
                  setEditQuota(e.target.value);
                }}
              />
            </FormField>
          </div>
          {/* 页脚：左取消右应用；busy 文案「应用中」；校验不过禁用应用 */}
          <FormFooter
            onCancel={() => {
              setEditOpen(false);
              setEditing(null);
            }}
            onSubmit={saveEdit}
            busy={pending}
            submitDisabled={!editFormValid}
          />
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
