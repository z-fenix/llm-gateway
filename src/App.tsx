import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import ChannelsPage from "./pages/ChannelsPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import RoleRoutesPage from "./pages/RoleRoutesPage";
import SecurityPage from "./pages/SecurityPage";
import LogsPage from "./pages/LogsPage";
import KnowledgePage from "./pages/KnowledgePage";
import SettingsPage from "./pages/SettingsPage";
import PromptsPage from "./pages/PromptsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/keys" element={<ApiKeysPage />} />
        <Route path="/roles" element={<RoleRoutesPage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
      </Route>
    </Routes>
  );
}
