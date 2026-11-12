import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, Layers, ShieldCheck, Timer, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { GATEWAY_REFRESH_EVENT } from "../lib/events";
import type { Stats, TimeBucket, UsageRangeSelection } from "../types";
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import { bucketSizeForRange, fillBuckets, localOffsetSecs } from "../lib/trend";
import { useRefreshInterval } from "../lib/useRefreshInterval";
import RefreshControls from "../components/RefreshControls";
import { UsageDateRangePicker } from "../components/UsageDateRangePicker";
import PageHeader from "../components/PageHeader";
import LoadingState from "../components/LoadingState";
import EmptyState from "../components/EmptyState";
import ErrorBanner from "../components/ErrorBanner";
import SegmentedControl from "../components/SegmentedControl";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { formatTokenAmount } from "../lib/tokenUnits";
import { cacheHitRatePercent, formatUsd, realTokens } from "../lib/usage";

const DIMENSION_TABS: { label: string; value: Dimension }[] = [
  { label: "调用量", value: "calls" }, { label: "Token", value: "tokens" },
  { label: "成功率", value: "success" }, { label: "风险分布", value: "risk" },
  { label: "缓存", value: "cache" }, { label: "成本", value: "cost" },
];

export default function DashboardPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<TimeBucket[] | null>(null);
  const [bucketSecs, setBucketSecs] = useState(3600);
  const [dimension, setDimension] = useState<Dimension>("calls");
  const [rangeSel, setRangeSel] = useState<UsageRangeSelection>({ preset: "today" });
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [secs, setSecs] = useRefreshInterval("dashboard-refresh");

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.getAppConfig().then((config) => { if (!cancelled) setAddress(config.bound_addr); }).catch(() => { if (!cancelled) setAddress(null); });
    api.getStats().then((value) => { if (!cancelled) setS(value); }).catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    let cancelled = false;
    setTrendError(null);
    const r = resolveUsageRange(rangeSel);
    const bs = bucketSizeForRange(r.startDate, r.endDate);
    const off = localOffsetSecs();
    api.getLogTimeseries({ after: r.startDate, before: r.endDate }, bs, off).then((data) => {
      if (!cancelled) {
        setBucketSecs(bs);
        setBuckets(data.length ? fillBuckets(data, r.startDate, r.endDate, bs, off) : []);
      }
    }).catch((err) => { if (!cancelled) setTrendError(String(err)); });
    return () => { cancelled = true; };
  }, [rangeSel, nonce]);

  useEffect(() => {
    if (!secs) return;
    const timer = setInterval(() => setNonce((n) => n + 1), secs * 1000);
    return () => clearInterval(timer);
  }, [secs]);

  const refresh = () => { setNonce((n) => n + 1); window.dispatchEvent(new Event(GATEWAY_REFRESH_EVENT)); };
  if (!s) return error ? <ErrorBanner message={error} onRetry={refresh} /> : <LoadingState />;
  const input = s.today_input_tokens ?? 0;
  const read = s.today_cache_read_tokens ?? 0;
  const creation = s.today_cache_creation_tokens ?? 0;
  const tokens = realTokens(input, s.today_output_tokens ?? 0, read, creation, s.today_fresh_input ?? input);
  const hitRate = cacheHitRatePercent(input, read, creation);
  const cards = [
    { label: "今日请求", value: s.today_requests.toLocaleString(), note: `累计 ${s.total_requests.toLocaleString()} 次`, icon: Activity },
    { label: "真实消耗 Token", value: formatTokenAmount(tokens), note: "已去重输入中的缓存消耗", icon: Layers },
    { label: "平均延迟", value: `${s.avg_latency_ms} ms`, note: "全量请求平均响应延迟", icon: Timer },
    { label: "今日估算费用", value: formatUsd(s.today_cost ?? 0), note: `累计估算 ${formatUsd(s.total_cost ?? 0)}`, icon: Wallet },
  ];

  return (
    <div className="page-stack" id="overview">
      <PageHeader title="运行概览" description="一处掌握本地网关的运行状态与今日用量。" action={<RefreshControls secs={secs} onSecsChange={setSecs} onRefresh={refresh} />} />
      {error && <ErrorBanner message={error} onRetry={refresh} />}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><UsageDateRangePicker selection={rangeSel} onApply={setRangeSel} triggerLabel={getUsageRangePresetLabel(rangeSel.preset)} /><span>今日统计 · {new Date().toLocaleDateString()} · 00:00 起</span><span className="ml-auto">{secs ? `自动刷新 ${secs} 秒` : "手动刷新"}</span></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, note, icon: Icon }) => <Card key={label} className="p-5"><div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground"><span>{label}</span><Icon size={16} /></div><p title={label === "真实消耗 Token" ? tokens.toLocaleString() : undefined} className="mt-3 text-[30px] font-semibold tracking-tight">{value}</p><p className="mt-2 text-[11px] text-muted-foreground">{note}</p></Card>)}
      </div>
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_304px]">
        <Card className="min-w-0">
          <CardHeader className="gap-3 pb-3"><div className="page-toolbar"><CardTitle className="text-base">请求趋势</CardTitle><SegmentedControl value={dimension} options={DIMENSION_TABS} onChange={setDimension} label="趋势维度" /></div><p className="text-[11px] text-muted-foreground">趋势范围独立于上方今日统计，可切换日期与维度。</p></CardHeader>
          <CardContent>
            {trendError ? <ErrorBanner message={trendError} onRetry={refresh} /> : buckets === null ? <LoadingState /> : buckets.length === 0 ? <EmptyState title="暂无数据" description="今天还没有请求记录" /> : <LogTrendChart buckets={buckets} dimension={dimension} bucketSecs={bucketSecs} compact />}
          </CardContent>
        </Card>
        <Card className="flex flex-col p-6">
          <h2 className="text-base font-semibold">运行摘要</h2>
          <p className="mt-4 text-xs text-muted-foreground">今日缓存命中率</p><p className="mt-2 text-[32px] font-semibold tracking-tight">{hitRate.toFixed(1)}%</p>
          <meter aria-label="今日缓存命中率" className="usage-meter mt-3 h-2 w-full" min={0} max={100} value={Math.min(100, hitRate)} />
          <p className="mt-3 text-[11px] text-muted-foreground">按输入与缓存 Token 计算</p>
          <dl className="mt-4 space-y-2 border-t border-border/60 pt-4 text-xs"><div className="flex justify-between"><dt className="text-muted-foreground">活跃渠道</dt><dd className="font-semibold">{s.active_channels}</dd></div><div className="flex justify-between"><dt className="text-muted-foreground">今日缓存命中</dt><dd title={read.toLocaleString()}>{formatTokenAmount(read)}</dd></div><div className="flex justify-between"><dt className="text-muted-foreground">累计估算费用</dt><dd>{formatUsd(s.total_cost ?? 0)}</dd></div></dl>
          <a href="#/security" className="mt-4 flex items-center gap-2 text-xs text-muted-foreground hover:text-primary"><ShieldCheck size={16} />查看安全检测配置<ArrowUpRight size={14} /></a>
        </Card>
      </div>
      <Card className="space-y-4 p-6"><div className="page-toolbar"><h2 className="text-base font-semibold">连接你的开发工具</h2><a href="#/settings?section=cli" className="inline-flex items-center gap-2 rounded-full border border-input px-4 py-2 text-xs font-medium hover:bg-muted">CLI 接入配置<ArrowUpRight size={14} /></a></div><dl className="grid gap-4 rounded-xl bg-background p-4 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">网关地址</dt><dd className="mt-2 break-all font-mono">{address ? `http://${address}` : "网关尚未连接"}</dd></div><div><dt className="text-muted-foreground">兼容协议</dt><dd className="mt-2">OpenAI Chat / Responses · Anthropic · MCP</dd></div></dl><p className="text-xs text-muted-foreground">使用本地 API 密钥访问网关；上游渠道凭据保持加密存储。</p></Card>
    </div>
  );
}
