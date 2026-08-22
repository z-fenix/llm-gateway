import { useEffect, useState } from "react";
import { Plus, RotateCcw, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import type { BuiltinRule, CustomRule, SecuritySettings } from "../types";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
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

const MODES = [
  { value: "audit", label: "审计模式" },
  { value: "warn", label: "告警模式" },
  { value: "redact", label: "脱敏模式" },
  { value: "block", label: "阻断模式" },
];

const SEVERITIES = ["clean", "info", "low", "medium", "high", "critical"];
const CATEGORIES = ["domain", "tool", "path", "keyword"];
const RULE_TYPES = ["blacklist", "whitelist"];

function SettingRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <span className="text-sm text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}

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

  const [deleting, setDeleting] = useState<CustomRule | null>(null);
  const [pending, setPending] = useState(false);

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

  const confirmDelete = async () => {
    if (!deleting) return;
    setError(null);
    setPending(true);
    try {
      await api.deleteCustomSecurityRule(deleting.id);
      setDeleting(null);
      load();
    } catch (err) {
      handleError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="安全审计"
        description="配置内容安全检测规则、扫描范围与处置模式。"
      />

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            总开关与模式
          </CardTitle>
          <CardDescription>
            开启安全审计后，网关将对进出请求执行内容安全检测
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <SettingRow
            label="启用安全审计"
            checked={settings.enabled}
            onCheckedChange={(v) => updateSetting("enabled", v)}
          />

          <div>
            <div className="mb-2 text-sm font-medium text-foreground">工作模式</div>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <label
                  key={m.value}
                  className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    settings.mode === m.value
                      ? "border-primary/40 bg-primary/10 font-medium text-primary"
                      : "border-input text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name="security-mode"
                    value={m.value}
                    className="sr-only"
                    checked={settings.mode === m.value}
                    onChange={() => updateSetting("mode", m.value)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
            {settings.mode === "redact" && (
              <p className="mt-2 text-xs text-amber-600">
                提示：脱敏模式需同时开启「自动脱敏密钥」才会生效。
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <SettingRow
              label="阻断严重风险"
              checked={settings.block_on_critical}
              onCheckedChange={(v) => updateSetting("block_on_critical", v)}
            />
            <SettingRow
              label="扫描请求"
              checked={settings.scan_request}
              onCheckedChange={(v) => updateSetting("scan_request", v)}
            />
            <SettingRow
              label="扫描响应"
              checked={settings.scan_response}
              onCheckedChange={(v) => updateSetting("scan_response", v)}
            />
            <SettingRow
              label="扫描 Unicode 编码"
              checked={settings.scan_unicode}
              onCheckedChange={(v) => updateSetting("scan_unicode", v)}
            />
            <SettingRow
              label="扫描工具调用"
              checked={settings.scan_tools}
              onCheckedChange={(v) => updateSetting("scan_tools", v)}
            />
            <SettingRow
              label="扫描网络相关"
              checked={settings.scan_network}
              onCheckedChange={(v) => updateSetting("scan_network", v)}
            />
            <SettingRow
              label="自动脱敏密钥"
              checked={settings.redact_secrets}
              onCheckedChange={(v) => updateSetting("redact_secrets", v)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="max-scan-bytes" className="text-sm">
              最大扫描字节数
            </Label>
            <Input
              id="max-scan-bytes"
              type="number"
              min={1024}
              className="w-32"
              value={settings.max_scan_bytes}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n) || n < 0) { setError("请输入非负数字"); return; }
                updateSetting("max_scan_bytes", n);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-lg">内置规则</CardTitle>
            <CardDescription>内置检测规则可单独启停，并调整风险级别</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={resetBuiltin}>
            <RotateCcw className="h-4 w-4" />
            重置默认
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">规则ID</th>
                  <th className="px-4 py-3 font-medium">类别</th>
                  <th className="px-4 py-3 font-medium">级别</th>
                  <th className="px-4 py-3 font-medium">标题</th>
                  <th className="px-4 py-3 font-medium">启用</th>
                  <th className="px-4 py-3 font-medium">级别</th>
                </tr>
              </thead>
              <tbody>
                {builtinRules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="border-b border-border last:border-0 hover:bg-accent/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      {rule.rule_id}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {rule.category}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{rule.severity}</Badge>
                    </td>
                    <td className="px-4 py-3 text-foreground">{rule.title}</td>
                    <td className="px-4 py-3">
                      <Switch
                        aria-label={`启用 ${rule.title}`}
                        checked={rule.enabled}
                        onCheckedChange={(v) =>
                          updateBuiltin(rule, v, rule.severity)
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={rule.severity}
                        onValueChange={(v) =>
                          updateBuiltin(rule, rule.enabled, v)
                        }
                      >
                        <SelectTrigger
                          className="h-8 w-28"
                          aria-label={`${rule.title} 级别`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEVERITIES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">自定义黑白名单</CardTitle>
          <CardDescription>
            自定义规则用于匹配请求/响应内容，动作与全局模式取严后生效
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select
                  value={form.rule_type}
                  onValueChange={(v) => setForm({ ...form, rule_type: v })}
                >
                  <SelectTrigger aria-label="规则类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t === "blacklist" ? "黑名单" : "白名单"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>类别</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm({ ...form, category: v })}
                >
                  <SelectTrigger aria-label="规则类别">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>级别</Label>
                <Select
                  value={form.severity}
                  onValueChange={(v) => setForm({ ...form, severity: v })}
                >
                  <SelectTrigger aria-label="规则级别">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-rule-pattern">匹配规则</Label>
                <Input
                  id="custom-rule-pattern"
                  placeholder="匹配规则（子串）"
                  value={form.pattern}
                  onChange={(e) => setForm({ ...form, pattern: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-rule-action">动作</Label>
                <Input
                  id="custom-rule-action"
                  placeholder="动作，如 block / redact"
                  value={form.action}
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="custom-rule-desc">描述</Label>
                <Input
                  id="custom-rule-desc"
                  placeholder="描述（可选）"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              规则动作与全局模式取严：Allow &lt; Warn &lt; Redact &lt; Block
            </p>
            <div className="mt-3">
              <Button onClick={createCustom} disabled={!form.pattern.trim()}>
                <Plus className="h-4 w-4" />
                新增
              </Button>
            </div>
          </div>

          {customRules.length === 0 ? (
            <EmptyState
              title="暂无自定义规则"
              description="还没有自定义黑白名单规则，在上方填写后点击「新增」"
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">类型</th>
                    <th className="px-4 py-3 font-medium">类别</th>
                    <th className="px-4 py-3 font-medium">规则</th>
                    <th className="px-4 py-3 font-medium">级别</th>
                    <th className="px-4 py-3 font-medium">动作</th>
                    <th className="px-4 py-3 font-medium">描述</th>
                    <th className="px-4 py-3 font-medium">启用</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {customRules.map((rule) => (
                    <tr
                      key={rule.id}
                      className="border-b border-border last:border-0 hover:bg-accent/50"
                    >
                      <td className="px-4 py-3 text-foreground">
                        {rule.rule_type === "blacklist" ? "黑名单" : "白名单"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {rule.category}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">
                        {rule.pattern}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{rule.severity}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {rule.action}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {rule.description ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <Switch
                          aria-label={`启用规则 ${rule.pattern}`}
                          checked={rule.enabled}
                          onCheckedChange={() => toggleCustom(rule)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="text-destructive hover:underline"
                          onClick={() => setDeleting(rule)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleting !== null}
        title="删除规则"
        message={
          deleting ? `确定删除规则「${deleting.pattern}」吗？` : undefined
        }
        pending={pending}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
