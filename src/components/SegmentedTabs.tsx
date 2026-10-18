import * as React from "react";

import { cn } from "../lib/utils";

export interface SegmentedTabsOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedTabsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedTabsOption<T>[];
  ariaLabel?: string;
}

/**
 * 分段选项卡（受控）。选中项：左侧 2px primary 竖条 + `bg-primary/10`；
 * 方向键（含 Home/End）同时移动焦点与选中（roving tabindex）。
 */
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: SegmentedTabsProps<T>) {
  const tabRefs = React.useRef(new Map<T, HTMLButtonElement>());

  const selectAndFocus = React.useCallback(
    (next: SegmentedTabsOption<T>) => {
      onChange(next.value);
      tabRefs.current.get(next.value)?.focus();
    },
    [onChange]
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (options.length === 0) return;
    const focusedValue = event.currentTarget.dataset.value as T;
    const idx = options.findIndex((o) => o.value === focusedValue);
    const current = idx === -1 ? 0 : idx;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        selectAndFocus(options[(current + 1) % options.length]);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        selectAndFocus(options[(current - 1 + options.length) % options.length]);
        break;
      case "Home":
        event.preventDefault();
        selectAndFocus(options[0]);
        break;
      case "End":
        event.preventDefault();
        selectAndFocus(options[options.length - 1]);
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            data-value={option.value}
            ref={(el) => {
              if (el) tabRefs.current.set(option.value, el);
              else tabRefs.current.delete(option.value);
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "rounded border-l-2 px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
