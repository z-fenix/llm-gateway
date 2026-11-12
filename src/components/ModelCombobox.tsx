import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/popover";

export function ModelCombobox({ value, onChange, options, loading, placeholder = "输入或选择模型…", className, error, id, ariaLabel, onBlur, openSignal = 0 }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  loading?: boolean;
  placeholder?: string;
  className?: string;
  error?: boolean;
  id?: string;
  ariaLabel?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  openSignal?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const input = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const filtered = [...new Set(options)].filter(option => option.toLowerCase().includes(query.toLowerCase()));
  React.useEffect(() => {
    if (!openSignal) return;
    setQuery("");
    setActive(0);
    setOpen(true);
    input.current?.focus();
  }, [openSignal]);
  React.useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, query, listId]);
  const choose = (model: string) => {
    onChange(model);
    setOpen(false);
    setQuery("");
    input.current?.focus();
  };
  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setActive(0); } }}>
      <PopoverAnchor asChild>
        <div className={cn("relative min-w-0 flex-1", className)}>
          <Input ref={input} id={id} role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined} aria-invalid={error || undefined} onBlur={onBlur} value={value} placeholder={placeholder}
            onClick={() => { setQuery(""); setOpen(true); }}
            onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); onChange(event.target.value); }}
            onKeyDown={event => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive(previous => !open ? 0 : Math.max(0, Math.min(filtered.length - 1, previous + (event.key === "ArrowDown" ? 1 : -1))));
                setOpen(true);
              } else if (event.key === "Enter" && open && filtered[active]) {
                event.preventDefault(); choose(filtered[active]);
              } else if (event.key === "Escape" && open) {
                event.preventDefault(); event.stopPropagation(); setOpen(false);
              }
            }}
            className={cn("pr-9", error && "border-destructive bg-destructive/5 focus-visible:ring-destructive/20")} />
          <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="选择模型" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"><ChevronsUpDown className="h-4 w-4 opacity-50" /></Button></PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={6} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} className="z-[70] max-h-[min(280px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-56 overflow-y-auto rounded-xl p-1.5">
        <div role="listbox" id={listId} aria-label="模型候选">
          {filtered.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">{loading ? "加载中…" : "无可用模型，可直接输入"}</p> : filtered.map((option, index) => (
            <button key={option} id={`${listId}-${index}`} type="button" role="option" aria-selected={option === value} onClick={() => choose(option)} onMouseEnter={() => setActive(index)} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent", active === index && "bg-accent", option === value && "font-medium")}>
              <span className="break-all">{option}</span>{option === value && <Check className="h-4 w-4 shrink-0" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
