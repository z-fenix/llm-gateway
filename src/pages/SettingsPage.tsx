import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type {
  ApiKey,
  AppConfigInfo,
  CliTargetInfo,
  CliWriteResult,
  ImportPreview,
  ImportResult,
} from "../types";

const CLI_TARGETS = ["claude_code", "codex"];

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

  const [exportPath, setExportPath] = useState("");
  const [exportBytes, setExportBytes] = useState<number | null>(null);

  const [importPath, setImportPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

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
      setRestarted(true);
      // 重启后刷新当前绑定地址
      const c = await api.getAppConfig();
      setConfig(c);
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
    } catch (err) {
      handleError(err);
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
    } catch (err) {
      handleError(err);
    }
  };

  const targetInfo = cliTargets.find((t) => t.target === target);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <button
              className="text-red-700 hover:underline"
              onClick={clearError}
              aria-label="关闭错误"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      <div>
        <h1 className="mb-2 text-xl font-bold">设置</h1>
        <p className="text-sm text-gray-500">应用配置、CLI 一键写入与配置导入导出。</p>
      </div>

      {/* 端口配置 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">端口配置</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">当前绑定地址:</span>
            <span className="font-mono">
              {config?.bound_addr ?? "未启动"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="preferred-port" className="text-gray-500">
              首选端口
            </label>
            <input
              id="preferred-port"
              type="number"
              min={8777}
              max={8787}
              className="border rounded px-2 py-1"
              value={preferredPort}
              onChange={(e) => setPreferredPort(e.target.value)}
            />
            <button
              className="rounded bg-blue-600 px-3 py-1 text-white"
              onClick={savePreferredPort}
            >
              保存
            </button>
            {portSaved && (
              <button
                className="rounded bg-green-600 px-3 py-1 text-white disabled:opacity-50"
                onClick={restartGateway}
                disabled={restarting}
              >
                {restarting ? "重启中..." : "立即重启"}
              </button>
            )}
          </div>
          {portSaved && !restarted && (
            <p className="text-sm text-green-600">
              已保存，点击“立即重启”使新端口生效。
            </p>
          )}
          {restarted && (
            <p className="text-sm text-green-600">网关已重启。</p>
          )}
          <p className="text-xs text-gray-400">
            修改首选端口后点击“立即重启”可让网关即刻改用新端口，无需重启应用；有效范围为
            8777-8787。
          </p>
        </div>
      </div>

      {/* CLI 一键写入 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">CLI 一键写入</h2>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-gray-500">目标 CLI</label>
            <select
              className="w-full border rounded px-2 py-1"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {CLI_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {targetInfo && (
              <div className="mt-2 text-xs text-gray-500">
                <p>
                  状态: {targetInfo.configured ? "已配置" : "未配置"}
                </p>
                <p className="truncate">路径: {targetInfo.path}</p>
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-500">API 密钥</label>
            <select
              className="w-full border rounded px-2 py-1"
              value={apiKeyId}
              onChange={(e) => setApiKeyId(e.target.value)}
            >
              {apiKeys.length === 0 && (
                <option value="">暂无密钥</option>
              )}
              {apiKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {target === "codex" && (
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="rounded border-gray-300"
              checked={writeEnv}
              onChange={(e) => setWriteEnv(e.target.checked)}
            />
            同时写入用户环境变量
          </label>
        )}

        <button
          className="rounded bg-blue-600 px-3 py-1 text-white"
          onClick={writeCli}
          disabled={!apiKeyId}
        >
          一键写入
        </button>

        {cliResults && (
          <div className="mt-4 space-y-3">
            {cliResults.map((r, idx) => (
              <div key={idx} className="rounded border p-3 text-sm">
                <p>
                  <span className="text-gray-500">配置文件:</span>{" "}
                  <span className="font-mono">{r.path}</span>
                </p>
                <p>
                  <span className="text-gray-500">备份文件:</span>{" "}
                  <span className="font-mono">
                    {r.backup_path ?? "无"}
                  </span>
                </p>
                <p className="text-gray-500">变更键:</p>
                {r.changed_keys.length === 0 ? (
                  <p className="text-gray-400">无变更</p>
                ) : (
                  <ul className="list-inside list-disc font-mono text-xs">
                    {r.changed_keys.map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ul>
                )}
                {r.env_instructions && (
                  <>
                    <p className="mt-2 text-gray-500">环境变量说明:</p>
                    <pre className="mt-1 overflow-auto rounded bg-gray-50 p-2 text-xs">
                      {r.env_instructions}
                    </pre>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 导出 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">导出配置</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            type="text"
            className="flex-1 min-w-[200px] border rounded px-2 py-1"
            placeholder="导出文件路径"
            value={exportPath}
            onChange={(e) => setExportPath(e.target.value)}
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-white"
            onClick={exportConfig}
          >
            导出
          </button>
        </div>
        <p className="text-xs text-amber-600">
          导出文件包含网关访问凭证（sk-lgw），请妥善保管；渠道 api_key
          已脱敏，导入后需重新补填。
        </p>
        {exportBytes !== null && (
          <p className="mt-2 text-sm text-green-600">
            导出成功：{exportBytes} 字节
          </p>
        )}
      </div>

      {/* 导入 */}
      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">导入配置</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            type="text"
            className="flex-1 min-w-[200px] border rounded px-2 py-1"
            placeholder="待导入文件路径"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-white"
            onClick={previewImportFile}
          >
            预览
          </button>
        </div>

        {preview && (
          <div className="mb-3 rounded border bg-gray-50 p-3 text-sm">
            <p className="font-medium">导入预览</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <p>渠道: {preview.channels}</p>
              <p>API 密钥: {preview.api_keys}</p>
              <p>角色路由: {preview.role_routes}</p>
              <p>角色模式: {preview.role_patterns}</p>
              <p>自定义规则: {preview.custom_rules}</p>
              <p>冲突: {preview.conflicts}</p>
            </div>
            {preview.conflicts > 0 ? (
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded bg-blue-600 px-3 py-1 text-white"
                  onClick={() => doImport("skip")}
                >
                  跳过已存在
                </button>
                <button
                  className="rounded bg-amber-600 px-3 py-1 text-white"
                  onClick={() => doImport("overwrite")}
                >
                  覆盖已存在
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <button
                  className="rounded bg-blue-600 px-3 py-1 text-white"
                  onClick={() => doImport("skip")}
                >
                  确认导入
                </button>
              </div>
            )}
          </div>
        )}

        {importResult && (
          <div className="rounded border bg-green-50 p-3 text-sm text-green-700">
            <p>导入完成</p>
            <p>已导入: {importResult.imported}</p>
            <p>已跳过: {importResult.skipped}</p>
            <p>已覆盖: {importResult.overwritten}</p>
          </div>
        )}
      </div>
    </div>
  );
}
