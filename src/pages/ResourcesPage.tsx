import { useSearchParams } from "react-router-dom";
import SegmentedControl from "../components/SegmentedControl";
import { PageNavigation } from "../components/PageHeader";
import KnowledgePage from "./KnowledgePage";
import PromptsPage from "./PromptsPage";
import McpServersPage from "./McpServersPage";
import SkillsPage from "./SkillsPage";

const TABS = [{ value: "knowledge", label: "知识库" }, { value: "prompts", label: "Prompt" }, { value: "mcp", label: "MCP" }, { value: "skills", label: "Skills" }] as const;

export default function ResourcesPage() {
  const [params, setParams] = useSearchParams();
  const value = params.get("tab");
  const tab = TABS.find((item) => item.value === value)?.value ?? "knowledge";
  return (
    <PageNavigation.Provider value={{ title: "资源", description: "统一管理知识库、Prompt、MCP 服务与 Skills。", navigation: <SegmentedControl value={tab} options={TABS} label="资源类型" onChange={(id) => {
        const next = new URLSearchParams(params);
        next.set("tab", id);
        setParams(next, { replace: true });
      }} /> }}>
      <section aria-label={TABS.find((item) => item.value === tab)?.label}>
        {tab === "knowledge" ? <KnowledgePage /> : tab === "prompts" ? <PromptsPage /> : tab === "mcp" ? <McpServersPage /> : <SkillsPage />}
      </section>
    </PageNavigation.Provider>
  );
}
