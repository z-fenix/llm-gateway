import { useSearchParams } from "react-router-dom";
import SegmentedControl from "../components/SegmentedControl";
import LogsPage from "./LogsPage";
import SessionsPage from "./SessionsPage";

const TABS = [{ value: "logs", label: "日志" }, { value: "sessions", label: "会话" }] as const;

export default function RecordsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "sessions" ? "sessions" : "logs";
  return (
    <div className="min-w-0 space-y-6">
      <SegmentedControl value={tab} options={TABS} label="日志与会话" onChange={(id) => {
        const next = new URLSearchParams(searchParams);
        next.set("tab", id);
        setSearchParams(next, { replace: true });
      }} />
      <section aria-label={tab === "logs" ? "请求日志" : "本地会话"}>{tab === "logs" ? <LogsPage /> : <SessionsPage />}</section>
    </div>
  );
}
