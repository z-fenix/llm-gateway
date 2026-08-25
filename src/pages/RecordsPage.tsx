import { useState } from "react";
import { cn } from "../lib/utils";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";

const TABS = [
  { id: "logs", label: "日志" },
  { id: "sessions", label: "会话" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function RecordsPage() {
  const [tab, setTab] = useState<TabId>("logs");

  return (
    <div>
      <div className="mb-4 flex items-center gap-1 rounded-xl border bg-card p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
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
