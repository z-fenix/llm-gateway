import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { cn } from "../lib/utils";
import { getUsageRangePresetLabel, resolveUsageRange } from "../lib/usageRange";
import type { UsageRangePreset, UsageRangeSelection } from "../types";

type DraftField = "start" | "end";

const PRESETS: UsageRangePreset[] = ["today", "1d", "7d", "14d", "30d"];

const L10N = {
  customRangeHint: "支持日期与时间，最长 30 天",
  startTime: "开始时间",
  endTime: "结束时间",
  liveEndTime: "结束时间跟随当前时刻",
  invalidTimeRangeOrder: "开始时间不能晚于结束时间",
  cancel: "取消",
  confirm: "确定",
};

interface UsageDateRangePickerProps {
  selection: UsageRangeSelection;
  onApply: (selection: UsageRangeSelection) => void;
  triggerLabel: string;
}

/* ── helpers ── */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toTs(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function fromTs(ts: number): Date {
  return new Date(ts * 1000);
}

function fmtDate(ts: number): string {
  const d = fromTs(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(ts: number): string {
  const d = fromTs(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function parseDateInput(ts: number, value: string): number {
  const [y, m, d] = value.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ts;
  const base = fromTs(ts);
  return toTs(new Date(y, m - 1, d, base.getHours(), base.getMinutes()));
}

function parseTimeInput(ts: number, value: string): number {
  const [h, min] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return ts;
  const base = fromTs(ts);
  return toTs(
    new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, min),
  );
}

function setDateKeepTime(ts: number, day: Date): number {
  const base = fromTs(ts);
  return toTs(
    new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      base.getHours(),
      base.getMinutes(),
    ),
  );
}

function getCalendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

/* ── component ── */

export function UsageDateRangePicker({
  selection,
  onApply,
  triggerLabel,
}: UsageDateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeField, setActiveField] = useState<DraftField>("start");
  const resolvedRange = useMemo(() => resolveUsageRange(selection), [selection]);
  const [draftStart, setDraftStart] = useState(resolvedRange.startDate);
  const [draftEnd, setDraftEnd] = useState(resolvedRange.endDate);
  const [draftLiveEnd, setDraftLiveEnd] = useState(
    selection.preset === "custom" ? (selection.liveEndTime ?? false) : false,
  );
  const [displayMonth, setDisplayMonth] = useState(
    () =>
      new Date(
        fromTs(resolvedRange.startDate).getFullYear(),
        fromTs(resolvedRange.startDate).getMonth(),
        1,
      ),
  );
  const [error, setError] = useState<string | null>(null);

  // 打开时把草稿重置为当前选择的解析结果
  useEffect(() => {
    if (!open) return;
    const r = resolveUsageRange(selection);
    setDraftStart(r.startDate);
    setDraftEnd(r.endDate);
    setDraftLiveEnd(
      selection.preset === "custom" ? (selection.liveEndTime ?? false) : false,
    );
    setDisplayMonth(
      new Date(
        fromTs(r.startDate).getFullYear(),
        fromTs(r.startDate).getMonth(),
        1,
      ),
    );
    setActiveField("start");
    setError(null);
  }, [open, selection]);

  // live-end 模式下每秒刷新结束时间
  useEffect(() => {
    if (!open || !draftLiveEnd) return;
    const tick = () => setDraftEnd(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [open, draftLiveEnd]);

  const calendarDays = useMemo(() => getCalendarDays(displayMonth), [displayMonth]);

  const weekdayLabels = ["日", "一", "二", "三", "四", "五", "六"];

  const startDay = fromTs(draftStart);
  const endDay = fromTs(draftEnd);
  const today = new Date();

  const handleDatePick = (day: Date) => {
    setError(null);

    // live-end 激活时日历只控制开始日期
    if (draftLiveEnd) {
      const nextTs = setDateKeepTime(draftStart, day);
      setDraftStart(nextTs);
      return;
    }

    const nextTs = setDateKeepTime(
      activeField === "start" ? draftStart : draftEnd,
      day,
    );

    if (activeField === "start") {
      setDraftStart(nextTs);
      // 自动交换:start > end 时把 end 同步为 start
      if (nextTs > draftEnd) {
        setDraftEnd(nextTs);
      }
      // 自动前进到结束字段
      setActiveField("end");
    } else {
      // 选中的结束早于开始时,当作新开始并继续
      if (nextTs < draftStart) {
        setDraftStart(nextTs);
        setActiveField("end");
      } else {
        setDraftEnd(nextTs);
      }
    }

    // 越月则切换日历显示月份
    if (
      day.getMonth() !== displayMonth.getMonth() ||
      day.getFullYear() !== displayMonth.getFullYear()
    ) {
      setDisplayMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    }
  };

  const handleApply = () => {
    setError(null);
    if (draftStart > draftEnd) {
      setError(L10N.invalidTimeRangeOrder);
      return;
    }
    onApply({
      preset: "custom",
      customStartDate: draftStart,
      customEndDate: draftEnd,
      liveEndTime: draftLiveEnd,
    });
    setOpen(false);
  };

  const goToToday = () => {
    setDisplayMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  };

  const renderField = (field: DraftField) => {
    const isActive = activeField === field;
    const isEndLive = field === "end" && draftLiveEnd;
    const ts = field === "start" ? draftStart : draftEnd;
    const setTs = field === "start" ? setDraftStart : setDraftEnd;
    const label = field === "start" ? L10N.startTime : L10N.endTime;

    return (
      <div
        className={cn(
          "rounded-lg border px-3 py-2 transition-all",
          isEndLive
            ? "border-border/30 bg-muted/30 cursor-not-allowed opacity-50"
            : isActive
              ? "border-primary ring-1 ring-primary/30 bg-primary/5 cursor-pointer"
              : "border-border/50 hover:border-border cursor-pointer",
        )}
        onClick={() => {
          if (!isEndLive) setActiveField(field);
        }}
      >
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            aria-label={label}
            className={cn(
              "h-7 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0",
              isEndLive && "pointer-events-none",
            )}
            value={fmtDate(ts)}
            onChange={(e) => {
              if (isEndLive) return;
              const next = parseDateInput(ts, e.target.value);
              setTs(next);
              const d = fromTs(next);
              setDisplayMonth(new Date(d.getFullYear(), d.getMonth(), 1));
              setError(null);
            }}
            onFocus={() => {
              if (!isEndLive) setActiveField(field);
            }}
            readOnly={isEndLive}
          />
          <Input
            type="time"
            step={60}
            className={cn(
              "h-7 w-[90px] flex-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0",
              isEndLive && "pointer-events-none",
            )}
            value={fmtTime(ts)}
            onChange={(e) => {
              if (isEndLive) return;
              setTs(parseTimeInput(ts, e.target.value));
              setError(null);
            }}
            onFocus={() => {
              if (!isEndLive) setActiveField(field);
            }}
            readOnly={isEndLive}
          />
        </div>
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={selection.preset === "custom" ? "default" : "outline"}
          className="h-9 w-[100px] justify-start gap-1.5 text-xs"
          title={triggerLabel}
        >
          <CalendarDays className="h-4 w-4 shrink-0" />
          <span className="truncate flex-1">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="usage-range-popover w-[620px] max-w-[calc(100vw-2rem)] p-3"
        align="end"
      >
        {/* 预设快捷按钮 */}
        <div className="flex flex-wrap gap-1.5 border-b border-border/40 pb-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="sm"
              variant={selection.preset === preset ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                onApply({ preset });
                setOpen(false);
              }}
            >
              {getUsageRangePresetLabel(preset)}
            </Button>
          ))}
        </div>

        <div className="usage-range-layout flex flex-col gap-3">
          {/* 左侧:日期字段 */}
          <div className="usage-range-fields space-y-2">
            <p className="text-xs text-muted-foreground">{L10N.customRangeHint}</p>
            {renderField("start")}
            {renderField("end")}

            <label className="flex cursor-pointer select-none items-center gap-2">
              <Checkbox
                checked={draftLiveEnd}
                onCheckedChange={(checked) => {
                  const live = checked === true;
                  setDraftLiveEnd(live);
                  if (live) {
                    setDraftEnd(Math.floor(Date.now() / 1000));
                    setActiveField("start");
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">{L10N.liveEndTime}</span>
            </label>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={() => setOpen(false)}
              >
                {L10N.cancel}
              </Button>
              <Button
                type="button"
                size="sm"
                className="flex-1"
                onClick={handleApply}
              >
                {L10N.confirm}
              </Button>
            </div>
          </div>

          {/* 右侧:日历 */}
          <div className="usage-range-calendar rounded-lg border border-border/50 bg-muted/30 p-2.5">
            {/* 月份导航 */}
            <div className="mb-1.5 flex items-center justify-between">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() =>
                  setDisplayMonth(
                    new Date(
                      displayMonth.getFullYear(),
                      displayMonth.getMonth() - 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <button
                type="button"
                className="text-sm font-medium transition-colors hover:text-primary"
                onClick={goToToday}
                title="当天"
              >
                {displayMonth.getFullYear()}年{displayMonth.getMonth() + 1}月
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() =>
                  setDisplayMonth(
                    new Date(
                      displayMonth.getFullYear(),
                      displayMonth.getMonth() + 1,
                      1,
                    ),
                  )
                }
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* 星期表头 */}
            <div className="mb-0.5 grid grid-cols-7 text-center text-[11px] text-muted-foreground">
              {weekdayLabels.map((label, i) => (
                <div key={i} className="py-0.5">
                  {label}
                </div>
              ))}
            </div>

            {/* 日网格 */}
            <div className="grid grid-cols-7 gap-px">
              {calendarDays.map((day) => {
                const isCurrentMonth = day.getMonth() === displayMonth.getMonth();
                const isToday = isSameDay(day, today);
                const isStart = isSameDay(day, startDay);
                const isEnd = isSameDay(day, endDay);
                const dayStart = startOfDay(day);
                const inRange =
                  dayStart >= startOfDay(startDay) &&
                  dayStart <= startOfDay(endDay);
                const isEndpoint = isStart || isEnd;

                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    aria-label={day.toLocaleDateString("zh-CN")}
                    aria-current={isToday ? "date" : undefined}
                    aria-pressed={isEndpoint}
                    className={cn(
                      "relative h-7 rounded text-xs transition-colors",
                      !isCurrentMonth && "text-muted-foreground/30",
                      isCurrentMonth && !inRange && "hover:bg-muted",
                      inRange && !isEndpoint && "bg-primary/10 text-primary",
                      isEndpoint && "bg-primary font-medium text-primary-foreground",
                      isToday && !isEndpoint && "ring-1 ring-primary/40",
                    )}
                    onClick={() => handleDatePick(day)}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
