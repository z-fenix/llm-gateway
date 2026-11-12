import { Loader2 } from "lucide-react";

export default function LoadingState() {
  return <div role="status" className="flex min-h-[180px] items-center justify-center gap-3 p-10 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />加载中...</div>;
}
