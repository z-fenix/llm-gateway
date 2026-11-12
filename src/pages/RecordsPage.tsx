import { useSearchParams } from "react-router-dom";
import SegmentedControl from "../components/SegmentedControl";
import { PageNavigation } from "../components/PageHeader";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";

const TABS = [{ value: "logs", label: "请求日志" }, { value: "sessions", label: "本地会话" }] as const;

export default function RecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "sessions" ? "sessions" : "logs";
  return (
    <PageNavigation.Provider value={{ title: "日志与会话", description: "从请求记录追踪调用，按本地会话还原上下文。", navigation: <SegmentedControl value={tab} options={TABS} label="日志与会话" onChange={(id) => {
        const next = new URLSearchParams(searchParams);
        next.set("tab", id);
        setSearchParams(next, { replace: true });
      }} /> }}>
      <section aria-label={tab === "logs" ? "请求日志" : "本地会话"}>{tab === "logs" ? <LogsPage /> : <SessionsPage />}</section>
    </PageNavigation.Provider>
  );
}
