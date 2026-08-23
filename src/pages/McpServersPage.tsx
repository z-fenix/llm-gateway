import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cable, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { McpServer, McpServerView } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";

type ServerType = "stdio" | "http";

interface ArgItem {
  id: string;
  value: string;
}

interface Pair {
  id: string;
  key: string;
  value: string;
}

const uid = () => crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

/** server_config.env / headers 对象 → 可编辑行。 */
function toPairs(obj: unknown): Pair[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).map(([key, value]) => ({
    id: uid(),
    key,
    value: value === null || value === undefined ? "" : String(value),
  }));
}

function pairsToObject(pairs: Pair[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k) obj[k] = value;
  }
  return obj;
}

export default function McpServersPage() {
  const [list, setList] = useState<McpServerView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [serverType, setServerType] = useState<ServerType>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<ArgItem[]>([]);
  const [envPairs, setEnvPairs] = useState<Pair[]>([]);
  const [url, setUrl] = useState("");
  const [headerPairs, setHeaderPairs] = useState<Pair[]>([]);
  const [pending, setPending] = useState(false);

  const [deleting, setDeleting] = useState<McpServer | null>(null);

  const handleError = (err: unknown) => {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    setError(msg);
    toast.error(msg);
  };

  const load = () => {
    setError(null);
    api.listMcpServers().then(setList).catch(handleError);
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setName("");
    setDescription("");
    setServerType("stdio");
    setCommand("");
    setArgs([]);
    setEnvPairs([]);
    setUrl("");
    setHeaderPairs([]);
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (s: McpServer) => {
    setEditing(s);
    setName(s.name);
    setDescription(s.description ?? "");
    const cfg = s.server_config ?? {};
    const type: ServerType =
      cfg.type === "http" || cfg.type === "sse" ? "http" : "stdio";
    setServerType(type);
    setCommand(String(cfg.command ?? ""));
    setArgs(
      Array.isArray(cfg.args)
        ? cfg.args.map((a: unknown) => ({ id: uid(), value: String(a) }))
        : []
    );
    setEnvPairs(toPairs(cfg.env));
    setUrl(String(cfg.url ?? ""));
    setHeaderPairs(toPairs(cfg.headers));
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  /** 切换 stdio/http 时清空另一类型的字段，避免陈旧配置被带入。 */
  const switchType = (t: ServerType) => {
    if (t === serverType) return;
    setServerType(t);
    if (t === "http") {
      setCommand("");
      setArgs([]);
      setEnvPairs([]);
    } else {
      setUrl("");
      setHeaderPairs([]);
    }
  };

  const buildConfig = (): Record<string, unknown> => {
    if (serverType === "http") {
      const cfg: Record<string, unknown> = { type: "http", url: url.trim() };
      const headers = pairsToObject(headerPairs);
      if (Object.keys(headers).length > 0) cfg.headers = headers;
      return cfg;
    }
    const cfg: Record<string, unknown> = { type: "stdio", command: command.trim() };
    const cleanArgs = args.map((a) => a.value.trim()).filter(Boolean);
    if (cleanArgs.length > 0) cfg.args = cleanArgs;
    const env = pairsToObject(envPairs);
    if (Object.keys(env).length > 0) cfg.env = env;
    return cfg;
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("名称不能为空");
      return;
    }
    if (serverType === "http" && !url.trim()) {
      toast.error("URL 不能为空");
      return;
    }
    if (serverType === "stdio" && !command.trim()) {
      toast.error("命令不能为空");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const payload: McpServer = {
        id: editing ? editing.id : "",
        name: trimmedName,
        server_config: buildConfig(),
        description: description.trim() || null,
        enabled: editing ? editing.enabled : false,
        created_at: editing ? editing.created_at : 0,
        updated_at: editing ? editing.updated_at : 0,
      };
      await api.upsertMcpServer(payload);
      toast.success(editing ? "MCP 服务器已更新" : "MCP 服务器已创建");
      closeDialog();
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const handleToggle = (v: McpServerView) => {
    setError(null);
    api
      .toggleMcpServerEnabled(v.server.id, !v.server.enabled)
      .then(load)
      .catch(handleError);
  };

  const handleConnect = (v: McpServerView) => {
    setError(null);
    api
      .connectMcpServer(v.server.id)
      .then(() => {
        toast.success("已连接");
        load();
      })
      .catch(handleError);
  };

  const handleDisconnect = (v: McpServerView) => {
    setError(null);
    api
      .disconnectMcpServer(v.server.id)
      .then(() => {
        toast.success("已断开");
        load();
      })
      .catch(handleError);
  };

  const handleTest = (v: McpServerView) => {
    setError(null);
    api.testMcpConnection(v.server.id).then(toast.success).catch(handleError);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteMcpServer(deleting.id);
      setDeleting(null);
      toast.success("MCP 服务器已删除");
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  const typeLabel = (s: McpServer) =>
    String(s.server_config?.type ?? "stdio");

  const pairsRow = (
    pairs: Pair[],
    onKey: (i: number, v: string) => void,
    onValue: (i: number, v: string) => void,
    onRemove: (i: number) => void,
    removeLabel: string
  ) =>
    pairs.map((p, i) => (
      <div key={p.id} className="flex items-center gap-2">
        <Input
          value={p.key}
          placeholder="KEY"
          className="font-mono"
          onChange={(e) => onKey(i, e.target.value)}
        />
        <Input
          value={p.value}
          placeholder="VALUE"
          className="font-mono"
          onChange={(e) => onValue(i, e.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          onClick={() => onRemove(i)}
        >
          <Trash2 size={16} />
        </Button>
      </div>
    ));

  return (
    <div>
      <PageHeader
        title="MCP 服务器"
        description="管理上游 MCP server，启用/连接即启动 client 握手"
        action={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新增
          </Button>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑 MCP 服务器" : "新增 MCP 服务器"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "修改服务器配置后保存"
                : "填写上游 MCP server 配置，保存后可启用连接"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">名称</Label>
              <Input
                id="mcp-name"
                placeholder="例如：本地 Python 服务"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-description">描述</Label>
              <Input
                id="mcp-description"
                placeholder="简要说明该服务器的用途"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>类型</Label>
              <Select
                value={serverType}
                onValueChange={(v) => switchType(v as ServerType)}
              >
                <SelectTrigger aria-label="类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {serverType === "stdio" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-command">命令</Label>
                  <Input
                    id="mcp-command"
                    placeholder="如 python（或可执行文件路径）"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>参数</Label>
                  {args.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-2">
                      <Input
                        value={a.value}
                        placeholder="参数"
                        className="font-mono"
                        onChange={(e) =>
                          setArgs((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, value: e.target.value } : x
                            )
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="删除参数"
                        onClick={() =>
                          setArgs((prev) => prev.filter((_, j) => j !== i))
                        }
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setArgs((prev) => [...prev, { id: uid(), value: "" }])}
                  >
                    <Plus size={16} /> 添加参数
                  </Button>
                </div>
                <div className="space-y-2">
                  <Label>环境变量</Label>
                  {pairsRow(
                    envPairs,
                    (i, v) =>
                      setEnvPairs((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, key: v } : p))
                      ),
                    (i, v) =>
                      setEnvPairs((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, value: v } : p))
                      ),
                    (i) => setEnvPairs((prev) => prev.filter((_, j) => j !== i)),
                    "删除环境变量"
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEnvPairs((prev) => [...prev, { id: uid(), key: "", value: "" }])
                    }
                  >
                    <Plus size={16} /> 添加环境变量
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    placeholder="如 https://example.com/mcp"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>请求头</Label>
                  {pairsRow(
                    headerPairs,
                    (i, v) =>
                      setHeaderPairs((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, key: v } : p))
                      ),
                    (i, v) =>
                      setHeaderPairs((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, value: v } : p))
                      ),
                    (i) =>
                      setHeaderPairs((prev) => prev.filter((_, j) => j !== i)),
                    "删除请求头"
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setHeaderPairs((prev) => [
                        ...prev,
                        { id: uid(), key: "", value: "" },
                      ])
                    }
                  >
                    <Plus size={16} /> 添加请求头
                  </Button>
                </div>
              </>
            )}
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={closeDialog} disabled={pending}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {list.length === 0 ? (
        <EmptyState
          icon={<Cable className="h-8 w-8" />}
          title="暂无 MCP 服务器"
          description="添加一个上游 MCP server，启用后网关将建立 client 连接"
        >
          <Button onClick={openCreate}>新增 MCP 服务器</Button>
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">描述</th>
                <th className="px-4 py-3 font-medium">类型</th>
                <th className="px-4 py-3 font-medium">连接</th>
                <th className="px-4 py-3 font-medium">启用</th>
                <th className="px-4 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr
                  key={v.server.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {v.server.name}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {v.server.description ?? "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {typeLabel(v.server)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs",
                        v.connected ? "text-emerald-600" : "text-muted-foreground"
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          v.connected
                            ? "bg-emerald-500"
                            : "bg-muted-foreground/50"
                        )}
                      />
                      {v.connected ? "已连接" : "未连接"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={v.server.enabled}
                      onCheckedChange={() => handleToggle(v)}
                      aria-label={`启用 ${v.server.name}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => openEdit(v.server)}
                      >
                        编辑
                      </button>
                      <button
                        className="text-emerald-600 hover:underline"
                        onClick={() => handleTest(v)}
                      >
                        测试
                      </button>
                      {v.connected ? (
                        <button
                          className="text-muted-foreground hover:underline"
                          onClick={() => handleDisconnect(v)}
                        >
                          断开
                        </button>
                      ) : (
                        <button
                          className="text-primary hover:underline"
                          onClick={() => handleConnect(v)}
                        >
                          连接
                        </button>
                      )}
                      <button
                        className="text-destructive hover:underline"
                        onClick={() => setDeleting(v.server)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="删除 MCP 服务器"
        message={
          deleting
            ? `确定删除 MCP 服务器「${deleting.name}」吗？若已连接将同时断开。`
            : undefined
        }
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
