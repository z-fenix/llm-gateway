import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Stats, TimeBucket } from "../types";
import PageHeader from "../components/PageHeader";
import LoadingState from "../components/LoadingState";
import EmptyState from "../components/EmptyState";
import LogTrendChart, { type Dimension } from "../components/LogTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

const DIMENSION_TABS: { label: string; value: Dimension }[] = [
  { label: "调用量", value: "calls" },
  { label: "Token", value: "tokens" },
  { label: "成功率", value: "success" },
  { label: "风险分布", value: "risk" },
];

const TREND_BUCKET_SECS = 3600;

// “今日趋势”只统计最近 24h,避免把全部历史都画成 1px 竖条还标注“今日”。
const TREND_WINDOW_SECS = 86400;

export default function DashboardPage() {
  const [s, setS] = useState<Stats | null>(null);
  const [buckets, setBuckets] = useState<TimeBucket[] | null>(null);
  const [dimension, setDimension] = useState<Dimension>("calls");

  useEffect(() => {
    api.getStats().then(setS).catch(console.error);
    api
      .getLogTimeseries({ after: Math.floor(Date.now() / 1000) - TREND_WINDOW_SECS }, TREND_BUCKET_SECS)
      .then(setBuckets)
      .catch(console.error);
  }, []);

  if (!s) return <LoadingState />;

  const cards = [
    { label: "今日请求", value: s.today_requests },
    { label: "今日 Token", value: s.today_tokens },
    { label: "累计请求", value: s.total_requests },
    { label: "累计 Token", value: s.total_tokens },
    { label: "活跃渠道", value: s.active_channels },
    { label: "平均延迟(ms)", value: s.avg_latency_ms },
  ];

  return (
    <div>
      <PageHeader title="概览" description="网关运行状况与今日请求趋势" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.label} className="p-4">
            <div className="text-sm text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{c.value}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">今日趋势</CardTitle>
          <div className="flex gap-1 text-sm" role="tablist" aria-label="趋势维度">
            {DIMENSION_TABS.map((tab) => (
              <button key={tab.value} role="tab" aria-selected={dimension === tab.value}
                onClick={() => setDimension(tab.value)}
                className={`rounded-md px-2 py-1 transition-colors ${
                  dimension === tab.value
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {buckets === null ? (
            <LoadingState />
          ) : buckets.length === 0 ? (
            <EmptyState title="暂无数据" description="今天还没有请求记录" />
          ) : (
            <LogTrendChart buckets={buckets} dimension={dimension} bucketSecs={TREND_BUCKET_SECS} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
