import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";
import type { Semantic } from "../lib/semantics";

const statusBadgeVariants = cva(
  "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
  {
    variants: {
      semantic: {
        success: "text-success bg-success/10",
        warning: "text-warning bg-warning/10",
        danger: "text-danger bg-danger/10",
        info: "text-info bg-info/10",
        neutral: "text-muted-foreground bg-faint/10",
      },
    },
    defaultVariants: {
      semantic: "neutral",
    },
  }
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  children: React.ReactNode;
}

function StatusBadge({ semantic, children, className, ...props }: StatusBadgeProps) {
  return (
    <span className={cn(statusBadgeVariants({ semantic }), className)} {...props}>
      {children}
    </span>
  );
}

export { StatusBadge, statusBadgeVariants };
export type { Semantic };
