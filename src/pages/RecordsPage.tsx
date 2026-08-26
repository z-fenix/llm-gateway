import { useSearchParams } from "react-router-dom";
import { cn } from "../lib/utils";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";

const TABS = [
  { id: "logs", label: "日志" },
  { id: "sessions", label: "会话" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const tabCls = (active: boolean) =>
  cn(
    "inline-flex min-w-[120px] items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all",
    active
      ? "bg-blue-500 text-white shadow-sm"
      : "text-muted-foreground opacity-60 hover:opacity-100 hover:bg-muted/50"
  );

export default function RecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // 活动页签提升到 URL 查询：同一路由不同查询不会重挂载，本地 useState 会让
  // 会话页「查看日志」跳转后仍停留在原页签；改为从 ?tab= 驱动即可随 URL 切换。
  const tabParam = searchParams.get("tab");
  const tab: TabId = tabParam === "sessions" ? "sessions" : "logs";
  const setTab = (id: TabId) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div>
      <div className="sticky top-0 z-10 mb-4">
        <div
          role="tablist"
          aria-orientation="horizontal"
          className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 text-muted-foreground"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={tabCls(tab === t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === "logs" ? <LogsPage /> : <SessionsPage />}
    </div>
  );
}
