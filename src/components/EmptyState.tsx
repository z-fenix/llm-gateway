import * as React from "react";
import { Inbox } from "lucide-react";

interface EmptyStateProps { icon?: React.ReactNode; title: string; description?: string; children?: React.ReactNode; }

export default function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center rounded-2xl bg-card px-6 py-12 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-background text-muted-foreground">{icon ?? <Inbox className="h-7 w-7" aria-hidden="true" />}</div>
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      {children && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}
