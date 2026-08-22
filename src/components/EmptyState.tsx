import * as React from "react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  children?: React.ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  children,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-10 text-center">
      {icon && <div className="mb-4 text-muted-foreground">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {description && (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {children && <div className="mt-4 flex items-center gap-2">{children}</div>}
    </div>
  );
}
