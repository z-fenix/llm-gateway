import { useSearchParams } from "react-router-dom";
import { cn } from "../lib/utils";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";

const TABS = [
  { id: "logs", label: "日志" },
  { id: "sessions", label: "会话" },
] as const;

type TabId = (typeof TABS)[number]["id"];

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
      <div className="sticky top-0 z-10 mb-4 flex items-center gap-1 rounded-xl border bg-card p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "logs" ? <LogsPage /> : <SessionsPage />}
    </div>
  );
}
