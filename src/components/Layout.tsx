import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Server, KeyRound, Route, ShieldCheck, ScrollText, Settings, Sparkles } from "lucide-react";
import { cn } from "../lib/utils";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/channels", label: "渠道", icon: Server },
  { to: "/keys", label: "密钥", icon: KeyRound },
  { to: "/roles", label: "角色路由", icon: Route },
  { to: "/security", label: "安全审计", icon: ShieldCheck },
  { to: "/logs", label: "日志与会话", icon: ScrollText },
  { to: "/knowledge", label: "资源", icon: Sparkles },
  { to: "/settings", label: "设置", icon: Settings },
];

export default function Layout() {
  return (
    <div className="flex h-screen flex-col">
      <header className="fixed z-50 h-16 w-full border-b bg-background/80 backdrop-blur-md">
        <div className="flex h-full items-center px-6 text-base font-bold text-foreground">
          llm-gateway
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden pt-16">
        <aside className="w-52 shrink-0 border-r bg-card">
          <nav className="space-y-1 p-3 pt-4">
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
        <main className="flex-1 overflow-auto bg-background px-6 pt-6 pb-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
