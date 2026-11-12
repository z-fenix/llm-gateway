import { DialogBody } from "./ui/dialog";
import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Download, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Channel, ModelMapEntry } from "../types";
import { STATIC_MODEL_CATALOG } from "../lib/modelCatalog";
import { ModelCombobox } from "./ModelCombobox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SecretInput } from "./form/SecretInput";
import { FormFooter } from "./form/FormFooter";
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
  onSubmit: (c: Channel) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Partial<Channel>>({
    supplier: "openai", upstream_protocol: "openai-chat", priority: 0, weight: 1, enabled: true,
    timeout_secs: 60, models: [""], ...initial,
  });
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<keyof Channel, boolean>>>({});
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const values = { ...f, api_key: secret || initial?.api_key || "" };
  const validation = validateForm(values);
  const errors: FieldErrors = Object.fromEntries(Object.entries(validation).filter(([key]) => attempted || touched[key as keyof Channel]));
  const touch = (key: keyof Channel) => setTouched((p) => ({ ...p, [key]: true }));
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));

  // ---- 支持模型：可搜索下拉（候选来自「从上游刷新」或内置静态清单） ----
  const [modelOptions, setModelOptions] = useState<string[]>(
    () => STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? []
  );
  const [modelFetching, setModelFetching] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [modelSource, setModelSource] = useState<"static" | "upstream" | "empty">("static");
  const [modelError, setModelError] = useState("");
  const modelRequest = useRef(0);
  useEffect(() => {
    modelRequest.current += 1;
    setModelFetching(false);
    setModelOptions(STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? []);
    setModelSource("static");
    setModelError("");
    return () => { modelRequest.current += 1; };
  }, [f.supplier, f.base_url, f.upstream_protocol, secret]);
  const changeSupplier = (v: string) => {
    setF(p => ({ ...p, supplier: v, ...(!initial?.id ? {
      upstream_protocol: v === "claude" ? "anthropic-messages" : v === "gemini" ? "gemini-native" : "openai-chat",
    } : {}) }));
  };
  const refreshModels = async () => {
    const request = ++modelRequest.current;
    setModelFetching(true);
    setModelError("");
    try {
      const list = await api.listChannelModels({
        baseUrl: (f.base_url ?? "").trim(),
        upstreamProtocol: f.upstream_protocol ?? "openai-chat",
        apiKey: secret || initial?.api_key || "",
        timeoutSecs: f.timeout_secs ?? 60,
        channelId,
      });
      if (request !== modelRequest.current) return;
      const models = [...new Set(list.map(m => m.trim()).filter(Boolean))];
      setModelSource(models.length ? "upstream" : "empty");
      setModelOptions(models.length ? models : STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? []);
      if (!(f.models ?? []).length) addModel();
      setModelRefresh(value => value + 1);
    } catch (err) {
      if (request !== modelRequest.current) return;
      setModelSource("static");
      setModelOptions(STATIC_MODEL_CATALOG[f.supplier ?? "openai"] ?? []);
      setModelError(`获取失败：${err instanceof Error ? err.message : String(err)}。请检查地址、协议与凭据，或手动输入模型 ID。`);
      if (!(f.models ?? []).length) addModel();
      setModelRefresh(value => value + 1);
    } finally {
      if (request === modelRequest.current) setModelFetching(false);
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
    touch("models");
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
    errors[k] ? <p role="alert" className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  const submit = async () => {
    if (saving) return;
    setAttempted(true);
    if (Object.keys(validation).length > 0) return;
    // 提交前 trim + 过滤空白模型，避免 "   " 之类的条目泄漏进 /v1/models 响应
    const models = (f.models ?? []).map((m) => m.trim()).filter(Boolean);
    setSaving(true);
    try {
      await onSubmit({ ...values, models } as Channel);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden">
      <DialogBody className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="channel-name">渠道名称 <span aria-hidden="true">*</span></Label>
        <Input id="channel-name" required className={inputCls("name")} placeholder="名称"
          value={f.name ?? ""} onBlur={() => touch("name")} aria-invalid={!!errors.name} onChange={(e) => set("name", e.target.value)} />
        {errMsg("name")}
      </div>

      <div className="space-y-1.5">
        <Label>供应商</Label>
        <Select value={f.supplier} onValueChange={changeSupplier}>
          <SelectTrigger aria-label="供应商"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SUPPLIERS.map((p) => <SelectItem key={p} value={p}>{{openai:"OpenAI",claude:"Anthropic",deepseek:"DeepSeek",gemini:"Google Gemini",custom:"自定义"}[p]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      </div>
      <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-1.5">
        <Label>上游协议 *</Label>
        <Select value={f.upstream_protocol} onValueChange={(v) => set("upstream_protocol", v)}>
          <SelectTrigger aria-label="上游协议"><SelectValue /></SelectTrigger>
          <SelectContent>
            {UPSTREAM_PROTOCOLS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="channel-base-url">Base URL *</Label>
        <Input id="channel-base-url" required className={inputCls("base_url")}
          placeholder="Base URL，如 https://api.deepseek.com"
          value={f.base_url ?? ""} onBlur={() => touch("base_url")} aria-invalid={!!errors.base_url} onChange={(e) => set("base_url", e.target.value)} />
        {errMsg("base_url")}
      </div>

      </div>
      <div className="space-y-1.5">
        <Label htmlFor="channel-api-key">API Key <span aria-hidden="true">*</span></Label>
        <div onBlur={() => touch("api_key")}><SecretInput value={secret} onChange={setSecret} saved={initial?.id ? "已保存，留空保持不变" : "输入上游 API Key"} ariaLabel="API Key" invalid={!!errors.api_key} disabled={saving} /></div>
        {errMsg("api_key")}
        <p className="text-[11px] text-muted-foreground">凭据将加密存储在本地，日志不会记录原始密钥。</p>
      </div>

      <div className="space-y-2" onBlur={() => touch("models")}>
        <div className="flex items-center justify-between">
          <Label>支持模型</Label>
          <Button type="button" variant="outline" size="sm" onClick={refreshModels} disabled={modelFetching}>
            {modelFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            获取模型列表
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {modelSource === "upstream"
            ? "已从上游加载模型，可直接选择或继续输入。"
            : modelSource === "empty"
              ? "上游返回空模型列表。下方仅为内置参考，可手动输入模型 ID。"
              : "内置参考清单，不代表上游已支持；获取真实列表或手动输入模型 ID。"}
        </p>
        {modelError && <p role="alert" className="text-xs text-destructive">{modelError}</p>}
        {(f.models ?? []).map((m, i) => (
          <div key={modelKeys.current[i] ?? `m${i}`} className="flex items-center gap-2">
            <ModelCombobox
              value={m}
              onChange={(v) => updateModel(i, v)}
              options={modelOptions}
              loading={modelFetching}
              openSignal={i === 0 ? modelRefresh : 0}
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

      {!channelId && <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-background p-4"><div><h3 className="text-sm font-medium">模型名称映射</h3><p className="mt-1 text-[11px] text-muted-foreground">创建后可配置请求模型到上游模型的映射。</p></div><Button variant="outline" size="sm" disabled>配置映射</Button></div>}
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
      <div className="space-y-1.5">
        <Label htmlFor="channel-timeout">超时（秒）</Label>
        <Input id="channel-timeout" type="number" className={inputCls("timeout_secs")}
          placeholder="超时秒数（>=1）" value={f.timeout_secs ?? 0}
          onBlur={() => touch("timeout_secs")} onChange={(e) => set("timeout_secs", Number(e.target.value))} />
        {errMsg("timeout_secs")}
      </div>
      </div>


      </DialogBody>
      <FormFooter onCancel={onCancel} onSubmit={submit} busy={saving} submitDisabled={Object.keys(validation).length > 0} submitLabel={initial?.id ? "保存渠道" : "创建渠道"} busyLabel="保存中…" />
    </div>
  );
}
