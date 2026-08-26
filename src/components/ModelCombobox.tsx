import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * 可搜索的模型选择框：既能直接打字输入任意模型 ID，也能点右下角展开下拉
 * 从候选中选中一项填入。候选（options）由父组件的「从上游刷新」或内置清单提供。
 */
export function ModelCombobox({
  value,
  onChange,
  options,
  loading,
  placeholder = "输入或选择模型…",
  className,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  loading?: boolean;
  placeholder?: string;
  className?: string;
  error?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const q = value.toLowerCase();
  const filtered = options.filter((o) => o.toLowerCase().includes(q));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn("relative flex-1", className)}>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cn(
            "pr-9",
            error && "border-destructive bg-destructive/5 focus-visible:ring-destructive/20"
          )}
        />
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="选择模型"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
          >
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="start" sideOffset={4} className="w-72 max-h-60 overflow-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {loading ? "加载中…" : "无可用模型，可直接输入"}
          </p>
        ) : (
          filtered.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                o === value && "bg-accent text-accent-foreground"
              )}
            >
              <span className="truncate">{o}</span>
              {o === value && <Check className="h-4 w-4 shrink-0" />}
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
