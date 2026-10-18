import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Download, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Channel, ModelMapEntry } from "../types";
import { STATIC_MODEL_CATALOG } from "../lib/modelCatalog";
import { ModelCombobox } from "./ModelCombobox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { FormField } from "./form/FormField";
import { FormFooter } from "./form/FormFooter";
import { SecretInput } from "./form/SecretInput";
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

/**
 * 前端与后端同一套校验规则（后端为准）。
 * apiKey 为实际生效值：创建态是草稿输入，编辑态留空时回退为加载时的掩码哨兵
 * （sk-***xxxx / ****）——后端 update_channel 视作「未变更」保留原值，故视为有效。
 */
function validateForm(f: Partial<Channel>, apiKey: string): FieldErrors {
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
  if (!apiKey.trim()) errs.api_key = "API Key 不能为空";
  if (!(f.models ?? []).some((m) => m.trim())) errs.models = "至少需要一个模型";
  if ((f.timeout_secs ?? 0) < 1) errs.timeout_secs = "超时时间必须大于等于 1 秒";
  return errs;
}

/** 折叠区「自定义设置」内可校验失败的字段（summary 行计数用）。 */
const COLLAPSED_KEYS = ["upstream_protocol", "priority", "weight", "timeout_secs"] as const;

export default function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (c: Channel) => void | Promise<void>;
  onCancel: () => void;
}) {
  // 编辑态（initial 带 id）时 initial.api_key 是后端打码哨兵（sk-***xxxx / ****），
  // write-only：永不回填展示；留空提交时原样回传，后端视作「未变更」保留原值。
  const isEdit = Boolean(initial?.id);
  const [savedKeySentinel] = useState(() => initial?.api_key ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [f, setF] = useState<Partial<Channel>>(() => {
    const { api_key: _sentinel, ...rest } = initial ?? {};
    return {
      supplier: "openai", upstream_protocol: "openai-chat", priority: 0, weight: 1, enabled: true,
      timeout_secs: 60, models: [], ...rest,
    };
  });
  const [busy, setBusy] = useState(false);
  // DSH touched 语义：pristine 空表单不喊错——行内错误仅「字段被触碰（blur/onChange）且无效」
  // 或「曾尝试提交」时渲染；应用按钮仍按原始校验态禁用（不受 touched 影响）。
  const [touched, setTouched] = useState<Partial<Record<keyof Channel, boolean>>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const effectiveKey = keyDraft || savedKeySentinel;
  // 实时校验（DSH：校验失败禁用应用）
  const errors = validateForm(f, effectiveKey);
  const touch = (k: keyof Channel) =>
    setTouched((p) => (p[k] ? p : { ...p, [k]: true }));
  const showErr = (k: keyof Channel) =>
    touched[k] || submitAttempted ? errors[k] : undefined;
  const set = (k: keyof Channel, v: any) => setF((p) => ({ ...p, [k]: v }));
  const blurField = (k: keyof Channel) => () => touch(k);

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
        // 编辑态草稿留空时回传掩码哨兵：后端按 channelId 从库取真实 key
        apiKey: effectiveKey,
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
    touch("models");
    set("models", [...(f.models ?? []), ""]);
  };
  const removeModel = (i: number) => {
    modelKeys.current.splice(i, 1);
    touch("models");
    const next = [...(f.models ?? [])];
    next.splice(i, 1);
    set("models", next);
  };
  const updateModel = (i: number, v: string) => {
    touch("models");
    const next = [...(f.models ?? [])];
    next[i] = v;
    set("models", next);
  };

  // ---- 模型映射（仅编辑已有渠道时展示，位于折叠区） ----
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

  const submit = async () => {
    setSubmitAttempted(true);
    if (busy) return;
    if (Object.keys(errors).length > 0) return; // 按钮已禁用，此处双保险
    // 提交前 trim + 过滤空白模型，避免 "   " 之类的条目泄漏进 /v1/models 响应；
    // 编辑态 key 留空 → 回传原掩码哨兵（后端视作未变更）
    const models = (f.models ?? []).map((m) => m.trim()).filter(Boolean);
    const payload = { ...f, models, api_key: effectiveKey } as Channel;
    setBusy(true);
    try {
      await onSubmit(payload);
    } finally {
      setBusy(false);
    }
  };

  const collapsedErrorCount = COLLAPSED_KEYS.filter((k) => !!showErr(k)).length;

  return (
    <div className="space-y-4">
      {/* ---- 主字段直显 ---- */}
      <FormField label="名称" htmlFor="channel-name" required error={showErr("name")}>
        <Input id="channel-name" placeholder="名称"
          value={f.name ?? ""}
          onBlur={blurField("name")}
          onChange={(e) => { touch("name"); set("name", e.target.value); }} />
      </FormField>

      <FormField label="供应商">
        <Select value={f.supplier} onValueChange={changeSupplier}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SUPPLIERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Base URL" htmlFor="channel-base-url" required error={showErr("base_url")}>
        <Input id="channel-base-url"
          placeholder="Base URL，如 https://api.deepseek.com"
          value={f.base_url ?? ""}
          onBlur={blurField("base_url")}
          onChange={(e) => { touch("base_url"); set("base_url", e.target.value); }} />
      </FormField>

      <FormField label="支持模型" required error={showErr("models")}>
        <div className="space-y-2">
          <div className="flex justify-end">
            {/* 辅助按钮保留在主字段区（对齐 DSH probe 先例） */}
            <Button type="button" variant="outline" size="sm" onClick={refreshModels} disabled={modelFetching}>
              {modelFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              获取模型列表
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {modelSource === "upstream"
              ? "已从上游加载模型，可直接选择或继续输入。"
              : "内置模型清单，可点击「获取模型列表」拉取上游真实模型。"}
          </p>
          {(f.models ?? []).map((m, i) => (
            <div key={modelKeys.current[i] ?? `m${i}`} className="flex items-center gap-2">
              <ModelCombobox
                value={m}
                onChange={(v) => updateModel(i, v)}
                options={modelOptions}
                loading={modelFetching}
                error={!!showErr("models")}
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
        </div>
      </FormField>

      <FormField label="API Key" required={!isEdit} error={showErr("api_key")}>
        {/* write-only：编辑态不回填（占位符提示已保存），留空提交 = 保持原值 */}
        <SecretInput
          value={keyDraft}
          onChange={(v) => { touch("api_key"); setKeyDraft(v); }}
          saved={isEdit ? "已保存，留空保持不变" : undefined}
          invalid={!!showErr("api_key")}
          ariaLabel="API Key"
        />
      </FormField>

      {/* ---- 折叠区：自定义设置（DSH details 模式，默认收起） ---- */}
      <details className="rounded-lg border border-border px-3">
        <summary className="flex cursor-pointer select-none items-center gap-2 py-2 text-sm font-medium text-foreground">
          自定义设置
          {/* 折叠区内字段出错：summary 行报错（对齐 DSH 卡片级 modelFailure 先例），
              让禁用的应用可解释 */}
          {collapsedErrorCount > 0 && (
            <span role="alert" className="text-xs font-normal text-destructive">
              自定义设置：{collapsedErrorCount} 项未通过
            </span>
          )}
        </summary>
        <div className="space-y-4 pb-3">
          <FormField label="上游协议">
            <Select value={f.upstream_protocol} onValueChange={(v) => set("upstream_protocol", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {UPSTREAM_PROTOCOLS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormField>

          {channelId && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm font-medium">模型映射</p>
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
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="优先级" htmlFor="channel-priority">
              <Input id="channel-priority" type="number"
                placeholder="优先级" value={f.priority ?? 0}
                onChange={(e) => set("priority", Number(e.target.value))} />
            </FormField>
            <FormField label="权重" htmlFor="channel-weight">
              <Input id="channel-weight" type="number"
                placeholder="权重" value={f.weight ?? 1}
                onChange={(e) => set("weight", Number(e.target.value))} />
            </FormField>
          </div>

          <FormField label="超时秒数" htmlFor="channel-timeout" error={showErr("timeout_secs")}>
            <Input id="channel-timeout" type="number"
              className={showErr("timeout_secs")
                ? "border-destructive bg-destructive/5 focus-visible:ring-destructive/20"
                : undefined}
              placeholder="超时秒数（>=1）" value={f.timeout_secs ?? 0}
              onBlur={blurField("timeout_secs")}
              onChange={(e) => { touch("timeout_secs"); set("timeout_secs", Number(e.target.value)); }} />
          </FormField>
        </div>
      </details>

      {/* ---- 页脚：左取消右应用；busy 文案「应用中」；校验不过禁用应用 ---- */}
      <FormFooter
        onCancel={onCancel}
        onSubmit={submit}
        busy={busy}
        submitDisabled={Object.keys(errors).length > 0}
      />
    </div>
  );
}
