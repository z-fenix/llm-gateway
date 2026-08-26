import { useState } from "react";
import { cn } from "../lib/utils";
import KnowledgePage from "./KnowledgePage";
import PromptsPage from "./PromptsPage";
import McpServersPage from "./McpServersPage";
import SkillsPage from "./SkillsPage";

const TABS = [
  { id: "knowledge", label: "知识库" },
  { id: "prompts", label: "Prompt" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const tabCls = (active: boolean) =>
  cn(
    "inline-flex min-w-[120px] items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all",
    active
      ? "bg-blue-500 text-white shadow-sm"
      : "text-muted-foreground opacity-60 hover:opacity-100 hover:bg-muted/50"
  );

export default function ResourcesPage() {
  const [tab, setTab] = useState<TabId>("knowledge");

  return (
    <div>
      <div className="sticky top-0 z-20 mb-4 bg-background">
        <div
          role="tablist"
          aria-orientation="horizontal"
          className="grid w-full grid-cols-4 rounded-lg bg-muted p-1 text-muted-foreground"
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
      {tab === "knowledge" ? (
        <KnowledgePage />
      ) : tab === "prompts" ? (
        <PromptsPage />
      ) : tab === "mcp" ? (
        <McpServersPage />
      ) : (
        <SkillsPage />
      )}
    </div>
  );
}
