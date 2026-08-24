import { RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { REFRESH_OPTIONS } from "../lib/useRefreshInterval";
import { cn } from "../lib/utils";

interface RefreshControlsProps {
  loading?: boolean;
  secs: number;
  onSecsChange: (s: number) => void;
  onRefresh: () => void;
}

export default function RefreshControls({
  loading,
  secs,
  onSecsChange,
  onRefresh,
}: RefreshControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        刷新
      </Button>
      <Select
        value={String(secs)}
        onValueChange={(v) => onSecsChange(Number(v))}
      >
        <SelectTrigger className="h-8 w-24" aria-label="自动刷新间隔">
          <SelectValue placeholder="自动刷新" />
        </SelectTrigger>
        <SelectContent>
          {REFRESH_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
