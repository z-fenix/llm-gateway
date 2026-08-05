import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Server, KeyRound, Route, ScrollText } from "lucide-react";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/channels", label: "渠道", icon: Server },
  { to: "/keys", label: "密钥", icon: KeyRound },
  { to: "/roles", label: "角色路由", icon: Route },
  { to: "/logs", label: "日志", icon: ScrollText },
];

export default function Layout() {
  return (
    <div className="flex h-screen">
      <aside className="w-52 border-r bg-white p-3">
        <div className="mb-6 px-2 text-lg font-bold">llm-gateway</div>
        <nav className="space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded px-3 py-2 text-sm ${isActive ? "bg-blue-600 text-white" : "hover:bg-gray-100"}`}>
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
