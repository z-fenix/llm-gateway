import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { BuiltinRule, CustomRule, SecuritySettings } from "../types";

const MODES = [
  { value: "audit", label: "审计模式" },
  { value: "warn", label: "告警模式" },
  { value: "redact", label: "脱敏模式" },
  { value: "block", label: "阻断模式" },
];

const SEVERITIES = ["clean", "info", "low", "medium", "high", "critical"];
const CATEGORIES = ["domain", "tool", "path", "keyword"];
const RULE_TYPES = ["blacklist", "whitelist"];

export default function SecurityPage() {
  const [settings, setSettings] = useState<SecuritySettings>({
    enabled: false,
    mode: "audit",
    scan_request: false,
    scan_response: false,
    scan_unicode: false,
    scan_tools: false,
    scan_network: false,
    redact_secrets: false,
    block_on_critical: false,
    max_scan_bytes: 65536,
  });
  const [builtinRules, setBuiltinRules] = useState<BuiltinRule[]>([]);
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    rule_type: "blacklist",
    category: "keyword",
    pattern: "",
    severity: "medium",
    action: "block",
    description: "",
  });

  const handleError = (err: unknown) => {
    console.error(err);
    setError(err instanceof Error ? err.message : String(err));
  };

  const load = () => {
    setError(null);
    api.getSecuritySettings().then(setSettings).catch(handleError);
    api.getBuiltinSecurityRules().then(setBuiltinRules).catch(handleError);
    api.getCustomSecurityRules().then(setCustomRules).catch(handleError);
  };

  useEffect(() => { load(); }, []);

  const updateSetting = (field: keyof SecuritySettings, value: unknown) => {
    setError(null);
    api.setSecuritySetting(field, value)
      .then(() => setSettings((prev) => ({ ...prev, [field]: value })))
      .catch(handleError);
  };

  const updateBuiltin = (rule: BuiltinRule, enabled: boolean, severity: string) => {
    setError(null);
    api.updateBuiltinSecurityRule(rule.id, enabled, severity)
      .then(load)
      .catch(handleError);
  };

  const resetBuiltin = () => {
    if (!window.confirm("确定重置全部内置规则为默认?自定义启停/级别将丢失。")) return;
    api.resetBuiltinSecurityRules().then(load).catch(handleError);
  };

  const createCustom = () => {
    if (!form.pattern.trim()) return;
    setError(null);
    api.createCustomSecurityRule(
      form.rule_type,
      form.category,
      form.pattern.trim(),
      form.severity,
      form.action.trim() || "block",
      form.description.trim() || null
    )
      .then(() => {
        load();
        setForm({ rule_type: "blacklist", category: "keyword", pattern: "", severity: "medium", action: "block", description: "" });
      })
      .catch(handleError);
  };

  const toggleCustom = (rule: CustomRule) => {
    setError(null);
    api.toggleCustomSecurityRule(rule.id, !rule.enabled)
      .then(load)
      .catch(handleError);
  };

  const deleteCustom = (rule: CustomRule) => {
    setError(null);
    api.deleteCustomSecurityRule(rule.id)
      .then(load)
      .catch(handleError);
  };

  const Toggle = ({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="rounded border-gray-300"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <div>
        <h1 className="mb-2 text-xl font-bold">安全审计</h1>
        <p className="mb-3 text-sm text-gray-500">
          配置内容安全检测规则、扫描范围与处置模式。
        </p>
      </div>

      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">总开关与模式</h2>
        <div className="space-y-4">
          <Toggle
            label="启用安全审计"
            checked={settings.enabled}
            onChange={(v) => updateSetting("enabled", v)}
          />

          <div>
            <div className="mb-1 text-sm font-medium">工作模式</div>
            <div className="flex flex-wrap gap-4">
              {MODES.map((m) => (
                <label key={m.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="security-mode"
                    value={m.value}
                    checked={settings.mode === m.value}
                    onChange={() => updateSetting("mode", m.value)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
            {settings.mode === "redact" && (
              <p className="mt-1 text-xs text-amber-600">
                提示：脱敏模式需同时开启「自动脱敏密钥」才会生效。
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Toggle
              label="阻断严重风险"
              checked={settings.block_on_critical}
              onChange={(v) => updateSetting("block_on_critical", v)}
            />
            <Toggle
              label="扫描请求"
              checked={settings.scan_request}
              onChange={(v) => updateSetting("scan_request", v)}
            />
            <Toggle
              label="扫描响应"
              checked={settings.scan_response}
              onChange={(v) => updateSetting("scan_response", v)}
            />
            <Toggle
              label="扫描 Unicode 编码"
              checked={settings.scan_unicode}
              onChange={(v) => updateSetting("scan_unicode", v)}
            />
            <Toggle
              label="扫描工具调用"
              checked={settings.scan_tools}
              onChange={(v) => updateSetting("scan_tools", v)}
            />
            <Toggle
              label="扫描网络相关"
              checked={settings.scan_network}
              onChange={(v) => updateSetting("scan_network", v)}
            />
            <Toggle
              label="自动脱敏密钥"
              checked={settings.redact_secrets}
              onChange={(v) => updateSetting("redact_secrets", v)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            最大扫描字节数
            <input
              type="number"
              className="w-32 border rounded px-2 py-1"
              min={1024}
              value={settings.max_scan_bytes}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n < 0) { setError("请输入非负数字"); return; }
                updateSetting("max_scan_bytes", n);
              }}
            />
          </label>
        </div>
      </div>

      <div className="rounded border bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">内置规则</h2>
          <button
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white"
            onClick={resetBuiltin}
          >
            重置默认
          </button>
        </div>
        <table className="w-full border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">规则ID</th>
              <th>类别</th>
              <th>级别</th>
              <th>标题</th>
              <th>启用</th>
              <th>级别</th>
            </tr>
          </thead>
          <tbody>
            {builtinRules.map((rule) => (
              <tr key={rule.id} className="border-b">
                <td className="p-2 font-mono">{rule.rule_id}</td>
                <td>{rule.category}</td>
                <td>{rule.severity}</td>
                <td>{rule.title}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`启用 ${rule.title}`}
                    checked={rule.enabled}
                    onChange={(e) =>
                      updateBuiltin(rule, e.target.checked, rule.severity)
                    }
                  />
                </td>
                <td>
                  <select
                    className="border rounded px-2 py-1"
                    value={rule.severity}
                    onChange={(e) =>
                      updateBuiltin(rule, rule.enabled, e.target.value)
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded border bg-white p-4">
        <h2 className="mb-3 font-semibold">自定义黑白名单</h2>

        <div className="mb-4 grid grid-cols-1 gap-2 rounded border bg-gray-50 p-3 sm:grid-cols-2 lg:grid-cols-7">
          <select
            className="border rounded px-2 py-1"
            value={form.rule_type}
            onChange={(e) => setForm({ ...form, rule_type: e.target.value })}
          >
            {RULE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "blacklist" ? "黑名单" : "白名单"}
              </option>
            ))}
          </select>
          <select
            className="border rounded px-2 py-1"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            className="border rounded px-2 py-1"
            placeholder="匹配规则（子串）"
            value={form.pattern}
            onChange={(e) => setForm({ ...form, pattern: e.target.value })}
          />
          <select
            className="border rounded px-2 py-1"
            value={form.severity}
            onChange={(e) => setForm({ ...form, severity: e.target.value })}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className="border rounded px-2 py-1"
            placeholder="动作，如 block / redact"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
          />
          <input
            className="border rounded px-2 py-1"
            placeholder="描述（可选）"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <button
            className="rounded bg-blue-600 px-3 py-1 text-white"
            onClick={createCustom}
          >
            新增
          </button>
        </div>

        <table className="w-full border bg-white text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">类型</th>
              <th>类别</th>
              <th>规则</th>
              <th>级别</th>
              <th>动作</th>
              <th>描述</th>
              <th>启用</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customRules.map((rule) => (
              <tr key={rule.id} className="border-b">
                <td className="p-2">
                  {rule.rule_type === "blacklist" ? "黑名单" : "白名单"}
                </td>
                <td>{rule.category}</td>
                <td className="font-mono">{rule.pattern}</td>
                <td>{rule.severity}</td>
                <td>{rule.action}</td>
                <td>{rule.description ?? "-"}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => toggleCustom(rule)}
                  />
                </td>
                <td>
                  <button
                    className="text-red-600"
                    onClick={() => deleteCustom(rule)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
