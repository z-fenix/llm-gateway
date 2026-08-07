import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import DashboardPage from "./pages/DashboardPage";
import ChannelsPage from "./pages/ChannelsPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import RoleRoutesPage from "./pages/RoleRoutesPage";
import SecurityPage from "./pages/SecurityPage";
import LogsPage from "./pages/LogsPage";

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
      </Route>
    </Routes>
  );
}
