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

export default function ResourcesPage() {
  const [tab, setTab] = useState<TabId>("knowledge");

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
