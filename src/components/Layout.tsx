import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Server,
  KeyRound,
  Route,
  ShieldCheck,
  ScrollText,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { api } from "../lib/api";
import { GATEWAY_REFRESH_EVENT } from "../lib/events";
import type { AppConfigInfo } from "../types";
import { gatewayStatus } from "../lib/gatewayStatus";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** 侧边栏三个内容分组（系统分组沉底，见 SYSTEM_GROUP） */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: "运行",
    items: [
      { to: "/", label: "概览", icon: LayoutDashboard },
      { to: "/logs", label: "日志与会话", icon: ScrollText },
    ],
  },
  {
    title: "配置",
    items: [
      { to: "/channels", label: "渠道", icon: Server },
      { to: "/keys", label: "密钥", icon: KeyRound },
      { to: "/roles", label: "角色路由", icon: Route },
    ],
  },
  {
    title: "能力",
    items: [
      { to: "/security", label: "安全审计", icon: ShieldCheck },
      { to: "/knowledge", label: "资源", icon: Sparkles },
    ],
  },
];

/** 系统分组：分隔线之后沉底 */
export const SYSTEM_GROUP: NavGroup = {
  title: "系统",
  items: [{ to: "/settings", label: "设置", icon: Settings }],
};

function NavLinks({ items }: { items: NavItem[] }) {
  return (
    <>
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 border-l-2 rounded-md px-3 py-2 text-sm transition-colors",
              isActive
                ? "border-l-primary bg-primary/10 font-medium text-primary"
                : "border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
            )
          }
        >
          <Icon size={16} /> {label}
        </NavLink>
      ))}
    </>
  );
}

export default function Layout() {
  const [config, setConfig] = useState<AppConfigInfo | null>(null);

  const fetchConfig = useCallback(() => {
    api
      .getAppConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    fetchConfig();
    const handler = () => fetchConfig();
    window.addEventListener(GATEWAY_REFRESH_EVENT, handler);
    return () => window.removeEventListener(GATEWAY_REFRESH_EVENT, handler);
  }, [fetchConfig]);

  const status = gatewayStatus(config?.bound_addr);
  const dotSemanticClass =
    status.semantic === "success" ? "bg-success" : "bg-danger";

  return (
    <div className="flex h-screen flex-col">
      <header className="fixed z-50 h-16 w-full border-b bg-background/80 backdrop-blur-md">
        <div className="flex h-full items-center justify-between px-6">
          <span className="font-mono text-base font-bold text-foreground">
            lg·gateway
          </span>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "h-2 w-2 rounded-full",
                dotSemanticClass,
                status.semantic === "success" &&
                  "animate-pulse motion-reduce:animate-none"
              )}
            />
            <span className="text-sm text-muted-foreground">{status.label}</span>
            {status.port && (
              <span className="font-mono text-xs text-faint">{status.port}</span>
            )}
          </div>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden pt-16">
        <aside className="w-52 shrink-0 border-r bg-surface">
          <nav className="p-3 pt-4">
            {NAV_GROUPS.map((group) => (
              <div key={group.title} className="pb-4">
                <div className="px-3 pb-1 text-xs font-medium text-faint">
                  {group.title}
                </div>
                <div className="space-y-1">
                  <NavLinks items={group.items} />
                </div>
              </div>
            ))}
            <hr className="my-3 border-border" data-testid="nav-divider" />
            <div>
              <div className="px-3 pb-1 text-xs font-medium text-faint">
                {SYSTEM_GROUP.title}
              </div>
              <div className="space-y-1">
                <NavLinks items={SYSTEM_GROUP.items} />
              </div>
            </div>
          </nav>
        </aside>
        <main className="flex-1 overflow-auto bg-background px-6 pt-6 pb-6">
          <div className="mx-auto max-w-[1440px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
