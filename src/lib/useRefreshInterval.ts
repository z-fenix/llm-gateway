import { useState } from "react";

export const REFRESH_SECS = [0, 5, 10, 30, 60] as const;

export const REFRESH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "关闭" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
];

/// 页面自动刷新间隔（秒，0=关闭），按 storageKey 持久化到 localStorage。
export function useRefreshInterval(storageKey: string): [number, (s: number) => void] {
  const [secs, setSecs] = useState<number>(() => {
    const raw = Number(window.localStorage.getItem(storageKey) ?? "0");
    return (REFRESH_SECS as readonly number[]).includes(raw) ? raw : 0;
  });
  const change = (s: number) => {
    setSecs(s);
    window.localStorage.setItem(storageKey, String(s));
  };
  return [secs, change];
}
