import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "../lib/theme";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const MODES = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
] as const;

export default function ThemeControl() {
  const { mode, setMode } = useTheme();
  const Current = MODES.find(item => item.value === mode)?.Icon ?? Monitor;
  return <Popover>
    <PopoverTrigger asChild><Button variant="ghost" size="sm" aria-label="主题设置" title="主题设置"><Current /><span className="hidden sm:inline">主题</span></Button></PopoverTrigger>
    <PopoverContent align="end" className="w-44 rounded-xl p-1.5" role="menu" aria-label="选择主题" onKeyDown={event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      event.preventDefault(); items[next]?.focus();
    }}>
      {MODES.map(({ value, label, Icon }) => <button key={value} role="menuitemradio" aria-checked={mode === value} onClick={() => setMode(value as ThemeMode)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"><Icon className="h-4 w-4 text-muted-foreground" />{label}{mode === value && <Check className="ml-auto h-4 w-4 text-primary" />}</button>)}
    </PopoverContent>
  </Popover>;
}
