import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, ChevronRight, CircleCheck, CircleAlert, LayoutDashboard, Server, KeyRound, Route, ShieldCheck, ScrollText, Settings, Layers, Network, Menu, X } from "lucide-react";
import { api } from "../lib/api";
import { GATEWAY_REFRESH_EVENT } from "../lib/events";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import ThemeControl from "./ThemeControl";

const nav = [
  { to: "/", label: "概览", icon: LayoutDashboard },
  { to: "/channels", label: "渠道", icon: Server },
  { to: "/keys", label: "密钥", icon: KeyRound },
  { to: "/roles", label: "角色路由", icon: Route },
  { to: "/security", label: "安全审计", icon: ShieldCheck },
  { to: "/logs", label: "日志与会话", icon: ScrollText },
  { to: "/knowledge", label: "资源", icon: Layers },
  { to: "/settings", label: "设置", icon: Settings },
];

export default function Layout() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "online" | "offline">("loading");
  const current = nav.find((item) => item.to === pathname) ?? nav[0];

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const panel = sidebarRef.current;
    const selector = 'a[href], button:not([disabled])';
    panel?.querySelector<HTMLElement>(selector)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = panel?.querySelectorAll<HTMLElement>(selector);
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      menuButtonRef.current?.focus();
    };
  }, [mobileOpen]);
  useEffect(() => {
    let disposed = false;
    const load = () => api.getAppConfig().then((config) => {
      if (disposed) return;
      setAddress(config.bound_addr || null);
      setStatus(config.bound_addr ? "online" : "offline");
    }).catch(() => { if (!disposed) setStatus("offline"); });
    void load();
    const timer = setInterval(load, 30000);
    window.addEventListener(GATEWAY_REFRESH_EVENT, load);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener(GATEWAY_REFRESH_EVENT, load); };
  }, []);

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden">
      <a href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }} className="sr-only z-50 rounded-xl bg-card p-3 focus:not-sr-only focus:absolute">跳到主内容</a>
      {mobileOpen && <button aria-label="关闭导航遮罩" className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setMobileOpen(false)} />}
      <aside ref={sidebarRef} id="workspace-navigation" aria-label="主导航" className={cn("fixed inset-y-0 left-0 z-40 w-[216px] shrink-0 flex-col border-r border-border/50 bg-card px-4 py-6 md:static md:flex md:w-[72px] md:px-3 xl:w-[216px] xl:px-4", mobileOpen ? "flex" : "hidden")}>
        <div className="flex h-9 items-center gap-2.5 px-2">
          <Network className="h-[22px] w-[22px] text-primary" aria-hidden="true" />
          <span className="whitespace-nowrap text-[17px] font-semibold tracking-tight md:hidden xl:inline">LLM Gateway</span>
          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 md:hidden" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X /></Button>
        </div>
        <p className="mb-5 mt-4 px-2 text-[10px] font-medium tracking-[0.14em] text-muted-foreground md:invisible xl:visible">LOCAL WORKSPACE</p>
        <nav className="space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} title={label} aria-label={label} end={to === "/"} className={({ isActive }) => cn("flex h-[42px] items-center gap-3 rounded-xl px-3 text-sm transition-colors", isActive ? "bg-accent font-semibold text-accent-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground")}>
              <Icon size={17} aria-hidden="true" /><span className="md:hidden xl:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-4 pt-8 md:hidden xl:block">
          <div className="space-y-2 rounded-xl bg-background p-3" role="status">
            <div className="flex items-center gap-2 text-xs font-medium">
              {status === "online" ? <CircleCheck className="h-3.5 w-3.5 text-[hsl(var(--success))]" /> : status === "offline" ? <CircleAlert className="h-3.5 w-3.5 text-muted-foreground" /> : <Activity className="h-3.5 w-3.5 text-muted-foreground" />}
              {status === "online" ? "网关运行中" : status === "offline" ? "网关未连接" : "正在连接网关"}
            </div>
            <p className="break-all font-mono text-[11px] text-muted-foreground">{address ?? "等待本地服务连接"}</p>
          </div>
          <div className="flex items-center justify-between px-2 text-[11px] text-muted-foreground"><span>v0.1.0</span><span>本地工作台</span></div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[72px] shrink-0 items-center justify-between gap-3 border-b border-border/50 bg-card px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3 text-[13px]">
            <Button ref={menuButtonRef} size="icon" variant="ghost" className="md:hidden" aria-label="打开导航" aria-controls="workspace-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu /></Button>
            <span className="hidden text-muted-foreground sm:inline">工作空间</span><ChevronRight className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" /><span className="truncate font-medium">{current.label}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2"><ThemeControl /><span className="hidden rounded-full bg-background px-3 py-1 text-[10px] font-medium tracking-wider text-muted-foreground sm:inline">LOCAL GATEWAY</span></div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-8"><Outlet /></main>
      </div>
    </div>
  );
}
