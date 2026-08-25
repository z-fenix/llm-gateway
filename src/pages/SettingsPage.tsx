import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CircleDollarSign,
  Download,
  FileJson,
  Import,
  Minimize2,
  RefreshCw,
  Server,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { api } from "../lib/api";
import type {
  ApiKey,
  AppConfigInfo,
  CliTargetInfo,
  ImportPreview,
  ImportResult,
  ModelPrice,
  RectifierConfig,
} from "../types";
import { normalizeModelId } from "../lib/usage";
import PageHeader from "../components/PageHeader";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
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

const CLI_TARGETS = ["claude_code", "codex"];

const CLI_TARGET_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
};

export default function SettingsPage() {
  const [error, setError] = useState<string | null>(null);

  const [config, setConfig] = useState<AppConfigInfo | null>(null);
  const [preferredPort, setPreferredPort] = useState<string>("");
  const [portSaved, setPortSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restarted, setRestarted] = useState(false);

  const [cliTargets, setCliTargets] = useState<CliTargetInfo[]>([]);
  const [target, setTarget] = useState<string>(CLI_TARGETS[0]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeyId, setApiKeyId] = useState<string>("");
  const [cliEditorOpen, setCliEditorOpen] = useState(false);
  const [cliJson, setCliJson] = useState("");
  const [cliLoading, setCliLoading] = useState(false);

  const [exportPath, setExportPath] = useState("");
  const [exportBytes, setExportBytes] = useState<number | null>(null);

  const [importPath, setImportPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const [rectifier, setRectifier] = useState<RectifierConfig>({
    enabled: true,
    request_thinking_signature: true,
    request_thinking_budget: true,
    request_media_fallback: true,
    request_media_heuristic: true,
  });

  const [minimizeToTray, setMinimizeToTray] = useState<boolean>(true);

  // 模型定价（估算费用）
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [priceModel, setPriceModel] = useState("");
  const [priceDisplayName, setPriceDisplayName] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [priceOutput, setPriceOutput] = useState("");
  const [priceCacheRead, setPriceCacheRead] = useState("");
  const [priceCacheCreation, setPriceCacheCreation] = useState("");
  const [editingPrice, setEditingPrice] = useState<ModelPrice | null>(null);

  const updateMinimizeToTray = (value: boolean) => {
    const prev = minimizeToTray;
    setMinimizeToTray(value);
    api.setMinimizeToTray(value).catch(() => {
      setMinimizeToTray(prev);
      toast.error("保存失败");
    });
  };

  const updateRectifier = (key: keyof RectifierConfig, value: boolean) => {
    const prev = rectifier[key];
    setRectifier((r) => ({ ...r, [key]: value }));
    api.setRectifierConfig(key, value).catch(() => {
      setRectifier((r) => ({ ...r, [key]: prev }));
      toast.error("整流器配置保存失败");
    });
  };

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const clearError = () => setError(null);

  useEffect(() => {
    clearError();
    api
      .getAppConfig()
      .then((c) => {
        setConfig(c);
        setPreferredPort(String(c.preferred_port));
        setMinimizeToTray(c.minimize_to_tray);
      })
      .catch(handleError);
    api.getCliTargets().then(setCliTargets).catch(handleError);
    api
      .listApiKeys()
      .then((keys) => {
        setApiKeys(keys);
        setApiKeyId(keys[0]?.id ?? "");
      })
      .catch(handleError);
    api
      .defaultExportPath()
      .then(setExportPath)
      .catch(handleError);
    api
      .getRectifierConfig()
      .then(setRectifier)
      .catch(handleError);
    api
      .listModelPrices()
      .then(setPrices)
      .catch(handleError);
  }, []);

  const savePreferredPort = async () => {
    const port = Number(preferredPort);
    if (!Number.isInteger(port) || port < 8777 || port > 8787) {
      setError("端口必须在 8777-8787 之间");
      return;
    }
    clearError();
    setPortSaved(false);
    setRestarted(false);
    try {
      await api.setPreferredPort(port);
      setPortSaved(true);
    } catch (err) {
      handleError(err);
    }
  };

  const restartGateway = async () => {
    clearError();
    setRestarting(true);
    setRestarted(false);
    try {
      await api.restartGateway();
      // 绑定是异步的:轮询 getAppConfig 直到 bound_addr 变化(最多 ~2s)
      const before = config?.bound_addr ?? null;
      for (let i = 0; i < 20; i++) {
        const c = await api.getAppConfig();
        if (c.bound_addr && c.bound_addr !== before) {
          setConfig(c);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      setRestarted(true);
    } catch (err) {
      handleError(err);
    } finally {
      setRestarting(false);
    }
  };

  const cliJsonInvalid = (() => {
    const trimmed = cliJson.trim();
    if (trimmed === "") return false;
    try {
      JSON.parse(cliJson);
      return false;
    } catch {
      return true;
    }
  })();

  const readCliConfigFor = async (t: string) => {
    setCliLoading(true);
    try {
      const content = await api.readCliConfig(t);
      setCliJson(content ?? "");
    } catch (err) {
      handleError(err);
    } finally {
      setCliLoading(false);
    }
  };

  const toggleCliEditor = () => {
    if (cliEditorOpen) {
      setCliEditorOpen(false);
      return;
    }
    setCliEditorOpen(true);
    void readCliConfigFor(target);
  };

  const formatCliJson = () => {
    try {
      const parsed = JSON.parse(cliJson);
      setCliJson(JSON.stringify(parsed, null, 2));
    } catch {
      toast.error("JSON 格式错误，无法格式化");
    }
  };

  const saveCliConfig = async () => {
    clearError();
    try {
      await api.writeCliConfigContent(target, cliJson);
      toast.success("CLI 配置已保存");
      api.getCliTargets().then(setCliTargets).catch(handleError);
    } catch (err) {
      handleError(err);
      toast.error("CLI 配置保存失败");
    }
  };

  const reloadCliConfig = () => {
    void readCliConfigFor(target);
  };

  // 编辑 Claude Code 配置时：把当前网关地址与所选密钥合并进编辑中的 JSON（仅改 env 两变量）
  const applyGatewayEnv = async () => {
    if (!apiKeyId) {
      toast.error("请先选择 API 密钥");
      return;
    }
    clearError();
    setCliLoading(true);
    try {
      const merged = await api.mergeGatewayEnv(cliJson, apiKeyId);
      setCliJson(merged);
      toast.success("已填入当前网关地址与密钥");
    } catch (err) {
      handleError(err);
      toast.error("设置当前网关失败");
    } finally {
      setCliLoading(false);
    }
  };

  const exportConfig = async () => {
    const path = exportPath.trim();
    if (!path) {
      setError("请输入导出路径");
      return;
    }
    clearError();
    setExportBytes(null);
    try {
      const bytes = await api.exportConfig(path);
      setExportBytes(bytes);
      toast.success("配置导出成功");
    } catch (err) {
      handleError(err);
    }
  };

  const previewImportFile = async () => {
    const path = importPath.trim();
    if (!path) {
      setError("请输入导入文件路径");
      return;
    }
    clearError();
    setPreview(null);
    setImportResult(null);
    try {
      const p = await api.previewImport(path);
      setPreview(p);
    } catch (err) {
      handleError(err);
    }
  };

  const doImport = async (strategy: string) => {
    const path = importPath.trim();
    if (!path) {
      setError("请输入导入文件路径");
      return;
    }
    clearError();
    try {
      const result = await api.importConfig(path, strategy);
      setImportResult(result);
      setPreview(null);
      toast.success("配置导入完成");
    } catch (err) {
      handleError(err);
    }
  };

  const targetInfo = cliTargets.find((t) => t.target === target);

  // ---- 模型定价（估算费用） ----
  const refreshPrices = () => {
    api.listModelPrices().then(setPrices).catch(handleError);
  };

  const normalizedModel = normalizeModelId(priceModel);

  const saveModelPrice = async () => {
    clearError();
    const modelId = normalizeModelId(priceModel);
    if (!modelId) {
      setError("模型名不能为空");
      return;
    }
    const input = Number(priceInput);
    const output = Number(priceOutput);
    const cacheRead = Number(priceCacheRead);
    const cacheCreation = Number(priceCacheCreation);
    if ([input, output, cacheRead, cacheCreation].some((n) => !Number.isFinite(n) || n < 0)) {
      setError("价格必须为非负数字");
      return;
    }
    try {
      await api.upsertModelPrice({
        model_id: modelId,
        display_name: priceDisplayName.trim() || modelId,
        input_cost_per_million: input,
        output_cost_per_million: output,
        cache_read_cost_per_million: cacheRead,
        cache_creation_cost_per_million: cacheCreation,
        updated_at: Math.floor(Date.now() / 1000),
      });
      toast.success(`已保存定价: ${modelId}`);
      cancelEditPrice();
      refreshPrices();
    } catch (err) {
      handleError(err);
      toast.error("保存定价失败");
    }
  };

  const editModelPrice = (p: ModelPrice) => {
    setEditingPrice(p);
    setPriceModel(p.model_id);
    setPriceDisplayName(p.display_name);
    setPriceInput(String(p.input_cost_per_million));
    setPriceOutput(String(p.output_cost_per_million));
    setPriceCacheRead(String(p.cache_read_cost_per_million));
    setPriceCacheCreation(String(p.cache_creation_cost_per_million));
  };

  const cancelEditPrice = () => {
    setEditingPrice(null);
    setPriceModel("");
    setPriceDisplayName("");
    setPriceInput("");
    setPriceOutput("");
    setPriceCacheRead("");
    setPriceCacheCreation("");
  };

  const deleteModelPrice = async (p: ModelPrice) => {
    const msg = `确定删除 ${p.model_id} 的定价？历史日志中该模型的估算费用将重算为 0。`;
    if (!window.confirm(msg)) return;
    try {
      await api.deleteModelPrice(p.model_id);
      toast.success(`已删除定价: ${p.model_id}`);
      refreshPrices();
    } catch (err) {
      handleError(err);
      toast.error("删除定价失败");
    }
  };

  const fillAnthropicReference = () => {
    const input = Number(priceInput);
    if (!Number.isFinite(input) || input <= 0) {
      toast.error("请先填写输入价格（每百万 token USD）");
      return;
    }
    setPriceCacheCreation((input * 1.25).toFixed(4));
    setPriceCacheRead((input * 0.1).toFixed(4));
    toast.success("已按 Anthropic 参考比例填充缓存价格");
  };

  return (
    <div>
      <PageHeader
        title="设置"
        description="应用配置、CLI 一键写入与配置导入导出"
      />

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button
            className="shrink-0 text-destructive/80 hover:underline"
            onClick={clearError}
            aria-label="关闭错误"
          >
            关闭
          </button>
        </div>
      )}

      {/* 端口配置 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Server className="h-4 w-4 text-muted-foreground" />
            端口配置
          </CardTitle>
          <CardDescription>
            修改首选端口后点击“立即重启”可让网关即刻改用新端口，无需重启应用；有效范围为
            8777-8787
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">当前绑定地址:</span>
              <span className="font-mono">
                {config?.bound_addr ?? "未启动"}
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-40 space-y-1.5">
                <Label htmlFor="preferred-port">首选端口</Label>
                <Input
                  id="preferred-port"
                  type="number"
                  min={8777}
                  max={8787}
                  value={preferredPort}
                  onChange={(e) => setPreferredPort(e.target.value)}
                />
              </div>
              <Button onClick={savePreferredPort}>保存</Button>
              {portSaved && (
                <Button
                  className="bg-emerald-600 text-white hover:bg-emerald-600/90"
                  onClick={restartGateway}
                  disabled={restarting}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${restarting ? "animate-spin" : ""}`}
                  />
                  {restarting ? "重启中..." : "立即重启"}
                </Button>
              )}
            </div>
            {portSaved && !restarted && (
              <p className="text-sm text-emerald-600">
                已保存，点击“立即重启”使新端口生效。
              </p>
            )}
            {restarted && (
              <p className="text-sm text-emerald-600">网关已重启。</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 关闭时最小化到托盘 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Minimize2 className="h-4 w-4 text-muted-foreground" />
            关闭行为
          </CardTitle>
          <CardDescription>
            点击窗口关闭按钮时隐藏到系统托盘，网关继续在后台运行
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>关闭时最小化到托盘</Label>
              <p className="text-xs text-muted-foreground">
                开启后关闭窗口仅隐藏到托盘，可从托盘菜单“显示主窗口”或“退出”恢复/结束
              </p>
            </div>
            <Switch
              checked={minimizeToTray}
              onCheckedChange={updateMinimizeToTray}
              aria-label="关闭时最小化到托盘"
            />
          </div>
        </CardContent>
      </Card>

      {/* 整流器 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            整流器
          </CardTitle>
          <CardDescription>
            Anthropic 兼容性错误自动整流重试与图片降级
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>启用整流器</Label>
              <p className="text-xs text-muted-foreground">
                关闭后所有整流与图片降级均不生效
              </p>
            </div>
            <Switch
              checked={rectifier.enabled}
              onCheckedChange={(v) => updateRectifier("enabled", v)}
              aria-label="启用整流器"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>修复 thinking signature 错误</Label>
              <p className="text-xs text-muted-foreground">
                删除 thinking 块并重试
              </p>
            </div>
            <Switch
              checked={rectifier.request_thinking_signature}
              disabled={!rectifier.enabled}
              onCheckedChange={(v) =>
                updateRectifier("request_thinking_signature", v)
              }
              aria-label="修复 thinking signature 错误"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>修复 thinking budget 错误</Label>
              <p className="text-xs text-muted-foreground">
                调整 budget_tokens 并重试
              </p>
            </div>
            <Switch
              checked={rectifier.request_thinking_budget}
              disabled={!rectifier.enabled}
              onCheckedChange={(v) =>
                updateRectifier("request_thinking_budget", v)
              }
              aria-label="修复 thinking budget 错误"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>图片降级（总开关）</Label>
              <p className="text-xs text-muted-foreground">
                开启后对媒体兼容性问题启用图片降级处理
              </p>
            </div>
            <Switch
              checked={rectifier.request_media_fallback}
              disabled={!rectifier.enabled}
              onCheckedChange={(v) =>
                updateRectifier("request_media_fallback", v)
              }
              aria-label="图片降级（总开关）"
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div className="space-y-0.5">
              <Label>发送前剥离图片（纯文本模型）</Label>
              <p className="text-xs text-muted-foreground">
                发送前将 image block 替换为文本标记
              </p>
            </div>
            <Switch
              checked={rectifier.request_media_heuristic}
              disabled={!rectifier.enabled || !rectifier.request_media_fallback}
              onCheckedChange={(v) =>
                updateRectifier("request_media_heuristic", v)
              }
              aria-label="发送前剥离图片（纯文本模型）"
            />
          </div>
        </CardContent>
      </Card>

      {/* 模型定价（估算费用） */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
            模型定价（估算费用）
          </CardTitle>
          <CardDescription>
            配置模型每百万 token 的估算单价（USD），用于请求日志与趋势的费用估算；按归一化模型名匹配（自动去掉 provider
            前缀/后缀，如 openrouter/anthropic/claude-sonnet-4.5:free → claude-sonnet-4.5）
          </CardDescription>
        </CardHeader>
        <CardContent>
          {prices.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">尚未配置模型定价</p>
          ) : (
            <div className="mb-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">模型</th>
                    <th className="px-4 py-2 font-medium">显示名</th>
                    <th className="px-4 py-2 font-medium">输入</th>
                    <th className="px-4 py-2 font-medium">输出</th>
                    <th className="px-4 py-2 font-medium">缓存命中</th>
                    <th className="px-4 py-2 font-medium">缓存创建</th>
                    <th className="px-4 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.model_id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-mono text-xs text-foreground">{p.model_id}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.display_name}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.input_cost_per_million}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.output_cost_per_million}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.cache_read_cost_per_million}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.cache_creation_cost_per_million}</td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => editModelPrice(p)}>
                            编辑
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => deleteModelPrice(p)}>
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">
                {editingPrice ? `编辑定价: ${editingPrice.model_id}` : "新增定价"}
              </p>
              {editingPrice && (
                <Button variant="ghost" size="sm" onClick={cancelEditPrice}>
                  取消编辑
                </Button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="price-model">模型名</Label>
                <Input
                  id="price-model"
                  placeholder="如 claude-sonnet-4.5"
                  value={priceModel}
                  onChange={(e) => setPriceModel(e.target.value)}
                />
                {normalizedModel && normalizedModel !== priceModel.trim().toLowerCase() && (
                  <p className="text-xs text-muted-foreground">
                    将归一化为:{" "}
                    <span className="font-mono text-foreground">{normalizedModel}</span>
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price-display-name">显示名（可选）</Label>
                <Input
                  id="price-display-name"
                  placeholder="Claude Sonnet 4.5"
                  value={priceDisplayName}
                  onChange={(e) => setPriceDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price-input">输入($/M)</Label>
                <Input
                  id="price-input"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="3"
                  value={priceInput}
                  onChange={(e) => setPriceInput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price-output">输出($/M)</Label>
                <Input
                  id="price-output"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="15"
                  value={priceOutput}
                  onChange={(e) => setPriceOutput(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price-cache-read">缓存命中($/M)</Label>
                <Input
                  id="price-cache-read"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="0.3"
                  value={priceCacheRead}
                  onChange={(e) => setPriceCacheRead(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="price-cache-creation">缓存创建($/M)</Label>
                <Input
                  id="price-cache-creation"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="3.75"
                  value={priceCacheCreation}
                  onChange={(e) => setPriceCacheCreation(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={saveModelPrice} aria-label="保存定价">
                {editingPrice ? "保存修改" : "保存"}
              </Button>
              <Button variant="outline" onClick={fillAnthropicReference} aria-label="Anthropic 参考">
                Anthropic 参考
              </Button>
              <span className="text-xs text-muted-foreground">
                缓存创建 ≈ 1.25×输入，缓存命中 ≈ 0.1×输入
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* CLI 一键写入 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <TerminalSquare className="h-4 w-4 text-muted-foreground" />
            CLI 一键写入
          </CardTitle>
          <CardDescription>
            将本地网关地址与密钥写入 Claude Code / Codex 配置，让 CLI 工具直连网关
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 space-y-1.5">
            <Label htmlFor="cli-target">目标 CLI</Label>
            <Select
              value={target}
              onValueChange={(v) => {
                setTarget(v);
                if (cliEditorOpen) {
                  void readCliConfigFor(v);
                }
              }}
            >
              <SelectTrigger id="cli-target" aria-label="目标 CLI">
                <SelectValue placeholder="选择目标 CLI" />
              </SelectTrigger>
              <SelectContent>
                {CLI_TARGETS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {CLI_TARGET_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetInfo && (
              <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                <p>
                  状态: {targetInfo.configured ? "已配置" : "未配置"}
                </p>
                <p className="truncate" title={targetInfo.path}>
                  路径: {targetInfo.path}
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button variant="outline" onClick={toggleCliEditor}>
              <FileJson className="h-4 w-4" />
              编辑配置
            </Button>
          </div>

          {cliEditorOpen && (
            <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  编辑 {CLI_TARGET_LABELS[target] ?? target} 配置
                  {target === "codex" && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      config.toml（将转为 JSON 编辑）
                    </span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={formatCliJson}
                    disabled={cliLoading}
                  >
                    格式化
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={reloadCliConfig}
                    disabled={cliLoading}
                  >
                    重新加载
                  </Button>
                  <Button
                    size="sm"
                    aria-label="保存 CLI 配置"
                    onClick={saveCliConfig}
                    disabled={cliLoading}
                  >
                    保存
                  </Button>
                </div>
              </div>
              {target === "claude_code" && (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[220px] space-y-1.5">
                    <Label htmlFor="editor-api-key">
                      API 密钥（写入 ANTHROPIC_AUTH_TOKEN）
                    </Label>
                    <Select value={apiKeyId} onValueChange={setApiKeyId}>
                      <SelectTrigger
                        id="editor-api-key"
                        className="h-8"
                        aria-label="编辑器 API 密钥"
                      >
                        <SelectValue placeholder="选择密钥" />
                      </SelectTrigger>
                      <SelectContent>
                        {apiKeys.map((k) => (
                          <SelectItem key={k.id} value={k.id}>
                            {k.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={applyGatewayEnv}
                    disabled={cliLoading}
                  >
                    设置当前网关
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    仅改写 env.ANTHROPIC_BASE_URL 与 env.ANTHROPIC_AUTH_TOKEN，其余保持 Claude Code 默认
                  </p>
                </div>
              )}
              {cliLoading && (
                <p className="text-xs text-muted-foreground">读取中...</p>
              )}
              <textarea
                className="min-h-[240px] w-full rounded-md border bg-background p-2 font-mono text-xs"
                value={cliJson}
                onChange={(e) => setCliJson(e.target.value)}
                aria-label="CLI 配置 JSON"
                spellCheck={false}
              />
              {cliJsonInvalid && (
                <p className="text-xs text-red-500">JSON 格式错误</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 导出 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Download className="h-4 w-4 text-muted-foreground" />
            导出配置
          </CardTitle>
          <CardDescription>
            将渠道、API 密钥、角色路由等配置导出为 JSON 文件
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input
              type="text"
              className="min-w-[220px] flex-1"
              placeholder="导出文件路径"
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
            />
            <Button onClick={exportConfig}>
              <Download className="h-4 w-4" />
              导出
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-amber-600">
            <FileJson className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            导出文件包含网关访问凭证（sk-lgw），请妥善保管；渠道 api_key
            已脱敏，导入后需重新补填。
          </p>
          {exportBytes !== null && (
            <p className="mt-2 text-sm text-emerald-600">
              导出成功：{exportBytes} 字节
            </p>
          )}
        </CardContent>
      </Card>

      {/* 导入 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Import className="h-4 w-4 text-muted-foreground" />
            导入配置
          </CardTitle>
          <CardDescription>
            从导出的 JSON 文件恢复配置，可预览冲突后选择跳过或覆盖
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-2">
            <Input
              type="text"
              className="min-w-[220px] flex-1"
              placeholder="待导入文件路径"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
            <Button variant="outline" onClick={previewImportFile}>
              预览
            </Button>
          </div>

          {preview && (
            <div className="mb-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">导入预览</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <p className="text-muted-foreground">
                  渠道: <span className="text-foreground">{preview.channels}</span>
                </p>
                <p className="text-muted-foreground">
                  API 密钥:{" "}
                  <span className="text-foreground">{preview.api_keys}</span>
                </p>
                <p className="text-muted-foreground">
                  角色路由:{" "}
                  <span className="text-foreground">{preview.role_routes}</span>
                </p>
                <p className="text-muted-foreground">
                  角色模式:{" "}
                  <span className="text-foreground">
                    {preview.role_patterns}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  自定义规则:{" "}
                  <span className="text-foreground">
                    {preview.custom_rules}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  冲突:{" "}
                  <span className="text-foreground">{preview.conflicts}</span>
                </p>
              </div>
              {preview.conflicts > 0 ? (
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => doImport("skip")}>
                    跳过已存在
                  </Button>
                  <Button
                    className="bg-amber-600 text-white hover:bg-amber-600/90"
                    onClick={() => doImport("overwrite")}
                  >
                    覆盖已存在
                  </Button>
                </div>
              ) : (
                <div className="mt-3">
                  <Button onClick={() => doImport("skip")}>
                    确认导入
                  </Button>
                </div>
              )}
            </div>
          )}

          {importResult && (
            <div className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-sm text-emerald-700">
              <p className="font-medium">导入完成</p>
              <p>已导入: {importResult.imported}</p>
              <p>已跳过: {importResult.skipped}</p>
              <p>已覆盖: {importResult.overwritten}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
