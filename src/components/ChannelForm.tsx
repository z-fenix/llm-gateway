import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Channel, ModelMapEntry } from "../types";
import { STATIC_MODEL_CATALOG } from "../lib/modelCatalog";
import { ModelCombobox } from "./ModelCombobox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const SUPPLIERS = ["openai", "claude", "deepseek", "gemini", "custom"];
const UPSTREAM_PROTOCOLS = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses API" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "gemini-native", label: "Gemini Native" },
];

type FieldErrors = Partial<Record<keyof Channel, string>>;

/** 前端与后端同一套校验规则（后端为准）。 */
function validateForm(f: Partial<Channel>): FieldErrors {
  const errs: FieldErrors = {};
  if (!(f.name ?? "").trim()) errs.name = "名称不能为空";
  const baseUrl = (f.base_url ?? "").trim();
  if (!baseUrl) errs.base_url = "Base URL 不能为空";
  else {
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errs.base_url = "Base URL 必须是 http/https 地址";
      }
    } catch {
      errs.base_url = "Base URL 格式无效";
    }
  }
  if (!(f.api_key ?? "").trim()) errs.api_key = "API Key 不能为空";
  if (!(f.models ?? []).some((m) => m.trim())) errs.models = "至少需要一个模型";
  if ((f.timeout_secs ?? 0) < 1) errs.timeout_secs = "超时时间必须大于等于 1 秒";
  return errs;
}

export default function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (c: Channel) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<Channel>>({
    supplier: "openai", upstream_protocol: "openai-chat", priority: 0, weight: 1, enabled: true,
    timeout_secs: 60, models: [], ...initial,
  });
  const [attempted, setAttempted] = useState(false);
  // 提交过一次后才展示错误，之后随输入实时更新
  const errors = attempted ? validateForm(f) : {};
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));

  // ---- 支持模型：可搜索下拉（候选来自「从上游刷新」或内置静态清单） ----
  const [modelOptions, setModelOptions] = useState<string[]>(
    () => STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? []
  );
  const [modelFetching, setModelFetching] = useState(false);
  const [modelSource, setModelSource] = useState<"static" | "upstream">("static");
  const applyStatic = (supplier: string) => {
    setModelOptions(STATIC_MODEL_CATALOG[supplier] ?? []);
    setModelSource("static");
  };
  const changeSupplier = (v: string) => {
    set("supplier", v);
    applyStatic(v);
  };
  const refreshModels = async () => {
    setModelFetching(true);
    try {
      const list = await api.listChannelModels({
        baseUrl: (f.base_url ?? "").trim(),
        upstreamProtocol: f.upstream_protocol ?? "openai-chat",
        apiKey: f.api_key ?? "",
        timeoutSecs: f.timeout_secs ?? 60,
        channelId: channelId,
      });
      // 上游列表 + 内置清单合并，兼顾准确与兜底；去重去空白。
      const merged = Array.from(
        new Set([...list, ...(STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? [])])
      ).filter(Boolean);
      if (merged.length > 0) setModelSource("upstream");
      setModelOptions(merged);
    } catch {
      applyStatic(f.supplier ?? "openai");
      toast.info("无法从上游获取模型，已切回内置清单");
    } finally {
      setModelFetching(false);
    }
  };

  // ---- 支持模型：动态多输入框（可增删） ----
  const uid = () => crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const modelKeys = useRef<string[]>((initial?.models ?? []).map(() => uid()));
  useEffect(() => {
    // 挂载时若长度不一致（如 initial 变化）则重置为对应长度
    const n = (f.models ?? []).length;
    if (modelKeys.current.length !== n) {
      modelKeys.current = Array.from({ length: n }, () => uid());
    }
    // 仅在挂载时同步一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const addModel = () => {
    modelKeys.current.push(uid());
    set("models", [...(f.models ?? []), ""]);
  };
  const removeModel = (i: number) => {
    modelKeys.current.splice(i, 1);
    const next = [...(f.models ?? [])];
    next.splice(i, 1);
    set("models", next);
  };
  const updateModel = (i: number, v: string) => {
    const next = [...(f.models ?? [])];
    next[i] = v;
    set("models", next);
  };

  // ---- 模型映射（仅编辑已有渠道时展示） ----
  const channelId = initial?.id;
  const [maps, setMaps] = useState<ModelMapEntry[] | null>(null);
  const [mapSrc, setMapSrc] = useState("");
  const [mapTgt, setMapTgt] = useState("");
  const [mapError, setMapError] = useState<string | null>(null);

  const reloadMaps = () => {
    if (!channelId) return;
    api
      .getModelMap(channelId)
      .then((m) => {
        setMaps(m);
        setMapError(null);
      })
      .catch(() => {
        // 加载失败不能伪装成“空映射”，要用独立错误提示区分
        setMaps([]);
        setMapError("模型映射加载失败");
      });
  };

  useEffect(() => {
    reloadMaps();
    // 渠道 id 变化时重新加载映射；依赖仅取 channelId
  }, [channelId]);

  const addMap = async () => {
    if (!channelId) return;
    const src = mapSrc.trim();
    const tgt = mapTgt.trim();
    if (!src || !tgt) {
      setMapError("源模型与目标模型不能为空");
      return;
    }
    setMapError(null);
    try {
      await api.setModelMap(channelId, src, tgt);
      setMapSrc("");
      setMapTgt("");
      reloadMaps();
    } catch (err) {
      setMapError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteMap = async (source: string) => {
    if (!channelId) return;
    setMapError(null);
    try {
      await api.deleteModelMap(channelId, source);
      reloadMaps();
    } catch (err) {
      setMapError(err instanceof Error ? err.message : String(err));
    }
  };

  const inputCls = (k: keyof Channel) =>
    errors[k] ? "border-destructive bg-destructive/5 focus-visible:ring-destructive/20" : undefined;
  const errMsg = (k: keyof Channel) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  const submit = () => {
    setAttempted(true);
    if (Object.keys(validateForm(f)).length > 0) return;
    // 提交前 trim + 过滤空白模型，避免 "   " 之类的条目泄漏进 /v1/models 响应
    const models = (f.models ?? []).map((m) => m.trim()).filter(Boolean);
    onSubmit({ ...f, models } as Channel);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="channel-name">名称</Label>
        <Input id="channel-name" className={inputCls("name")} placeholder="名称"
          value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} />
        {errMsg("name")}
      </div>

      <div className="space-y-1.5">
        <Label>供应商</Label>
        <Select value={f.supplier} onValueChange={changeSupplier}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SUPPLIERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>上游协议</Label>
        <Select value={f.upstream_protocol} onValueChange={(v) => set("upstream_protocol", v)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {UPSTREAM_PROTOCOLS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="channel-base-url">Base URL</Label>
        <Input id="channel-base-url" className={inputCls("base_url")}
          placeholder="Base URL，如 https://api.deepseek.com"
          value={f.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} />
        {errMsg("base_url")}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="channel-api-key">API Key</Label>
        <Input id="channel-api-key" className={inputCls("api_key")}
          placeholder="真实上游 API Key"
          value={f.api_key ?? ""} onChange={(e) => set("api_key", e.target.value)} />
        {errMsg("api_key")}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>支持模型</Label>
          <Button type="button" variant="outline" size="sm" onClick={refreshModels} disabled={modelFetching}>
            {modelFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            从上游刷新
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {modelSource === "upstream"
            ? "已从上游加载模型，可直接选择或继续输入。"
            : "内置模型清单，可点击「从上游刷新」拉取上游真实模型。"}
        </p>
        {(f.models ?? []).map((m, i) => (
          <div key={modelKeys.current[i] ?? `m${i}`} className="flex items-center gap-2">
            <ModelCombobox
              value={m}
              onChange={(v) => updateModel(i, v)}
              options={modelOptions}
              loading={modelFetching}
              error={!!errors.models}
            />
            <Button type="button" variant="ghost" size="icon"
              aria-label="删除模型" onClick={() => removeModel(i)}>
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addModel}>
          <Plus size={16} /> 添加模型
        </Button>
        {errMsg("models")}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="channel-priority">优先级</Label>
          <Input id="channel-priority" type="number" className={inputCls("priority")}
            placeholder="优先级" value={f.priority ?? 0}
            onChange={(e) => set("priority", Number(e.target.value))} />
          {errMsg("priority")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="channel-weight">权重</Label>
          <Input id="channel-weight" type="number" className={inputCls("weight")}
            placeholder="权重" value={f.weight ?? 1}
            onChange={(e) => set("weight", Number(e.target.value))} />
          {errMsg("weight")}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="channel-timeout">超时秒数</Label>
        <Input id="channel-timeout" type="number" className={inputCls("timeout_secs")}
          placeholder="超时秒数（>=1）" value={f.timeout_secs ?? 0}
          onChange={(e) => set("timeout_secs", Number(e.target.value))} />
        {errMsg("timeout_secs")}
      </div>

      {channelId && (
        <Accordion type="single" collapsible defaultValue="model-map" className="rounded-lg border border-border px-3">
          <AccordionItem value="model-map" className="border-b-0">
            <AccordionTrigger>模型映射</AccordionTrigger>
            <AccordionContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                把请求中的源模型名映射为上游使用的目标模型名，保存后立即生效。
              </p>
              {mapError && <p className="text-xs text-destructive">{mapError}</p>}
              <div className="space-y-2">
                {maps === null ? (
                  <p className="text-xs text-muted-foreground">加载中…</p>
                ) : maps.length === 0 && !mapError ? (
                  <p className="text-xs text-muted-foreground">暂无模型映射</p>
                ) : (
                  maps.map((m) => (
                    <div key={m.source_model}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                      <div className="flex items-center gap-2 text-sm">
                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">{m.source_model}</code>
                        <span className="text-muted-foreground">→</span>
                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">{m.target_model}</code>
                      </div>
                      <Button type="button" variant="ghost" size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteMap(m.source_model)}>删除</Button>
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <Input className="flex-1" placeholder="源模型" value={mapSrc}
                  onChange={(e) => setMapSrc(e.target.value)} />
                <Input className="flex-1" placeholder="目标模型" value={mapTgt}
                  onChange={(e) => setMapTgt(e.target.value)} />
                <Button type="button" size="sm" onClick={addMap}>添加</Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
        <Button type="button" onClick={submit}>保存</Button>
      </div>
    </div>
  );
}
