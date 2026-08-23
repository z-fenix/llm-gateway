import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  FileJson,
  Import,
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
  CliWriteResult,
  ImportPreview,
  ImportResult,
  RectifierConfig,
} from "../types";
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
  const [writeEnv, setWriteEnv] = useState(true);
  const [cliResults, setCliResults] = useState<CliWriteResult[] | null>(null);
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

  const writeCli = async () => {
    if (!apiKeyId) {
      setError("请选择 API 密钥");
      return;
    }
    clearError();
    setCliResults(null);
    try {
      const results = await api.writeCliConfig(target, apiKeyId, writeEnv);
      setCliResults(results);
      toast.success("CLI 配置写入完成");
    } catch (err) {
      handleError(err);
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
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <Label htmlFor="cli-api-key">API 密钥</Label>
              <Select
                value={apiKeyId}
                onValueChange={setApiKeyId}
                disabled={apiKeys.length === 0}
              >
                <SelectTrigger id="cli-api-key" aria-label="API 密钥">
                  <SelectValue placeholder="选择 API 密钥" />
                </SelectTrigger>
                <SelectContent>
                  {apiKeys.length === 0 && (
                    <SelectItem value="__none__">暂无密钥</SelectItem>
                  )}
                  {apiKeys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {target === "codex" && (
            <label className="mb-4 flex w-fit items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={writeEnv}
                onChange={(e) => setWriteEnv(e.target.checked)}
              />
              同时写入用户环境变量
            </label>
          )}

          <Button onClick={writeCli} disabled={!apiKeyId}>
            <TerminalSquare className="h-4 w-4" />
            一键写入
          </Button>

          {cliResults && (
            <div className="mt-4 space-y-3">
              {cliResults.map((r, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-border p-3 text-sm"
                >
                  <p>
                    <span className="text-muted-foreground">配置文件:</span>{" "}
                    <span className="font-mono">{r.path}</span>
                  </p>
                  <p>
                    <span className="text-muted-foreground">备份文件:</span>{" "}
                    <span className="font-mono">
                      {r.backup_path ?? "无"}
                    </span>
                  </p>
                  <p className="text-muted-foreground">变更键:</p>
                  {r.changed_keys.length === 0 ? (
                    <p className="text-muted-foreground/70">无变更</p>
                  ) : (
                    <ul className="list-inside list-disc font-mono text-xs">
                      {r.changed_keys.map((k) => (
                        <li key={k}>{k}</li>
                      ))}
                    </ul>
                  )}
                  {r.env_instructions && (
                    <>
                      <p className="mt-2 text-muted-foreground">
                        环境变量说明:
                      </p>
                      <pre className="mt-1 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs">
                        {r.env_instructions}
                      </pre>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

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
