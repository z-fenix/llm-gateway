import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Server, KeyRound, Route, ShieldCheck, ScrollText, BookOpen, Settings } from "lucide-react";
import { cn } from "../lib/utils";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/channels", label: "渠道", icon: Server },
  { to: "/keys", label: "密钥", icon: KeyRound },
  { to: "/roles", label: "角色路由", icon: Route },
  { to: "/security", label: "安全审计", icon: ShieldCheck },
  { to: "/logs", label: "日志", icon: ScrollText },
  { to: "/knowledge", label: "知识库", icon: BookOpen },
  { to: "/settings", label: "设置", icon: Settings },
];

export default function Layout() {
  return (
    <div className="flex h-screen">
      <aside className="w-52 border-r bg-card">
        <div className="flex h-14 items-center border-b px-4 text-base font-bold text-foreground">
          llm-gateway
        </div>
        <nav className="space-y-1 p-3">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-background p-6">
        <Outlet />
      </main>
    </div>
  );
}
