import * as React from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  navigationAction?: React.ReactNode;
}

export const PageNavigation = React.createContext<{
  title: string;
  description?: string;
  navigation: React.ReactNode;
} | null>(null);

export default function PageHeader({ title, description, action, navigationAction }: PageHeaderProps) {
  const group = React.useContext(PageNavigation);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.6px]">{group?.title ?? title}</h1>
          {(group?.description ?? description) && <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{group?.description ?? description}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {(group?.navigation || navigationAction) && <div className="page-toolbar">{group?.navigation}{navigationAction}</div>}
    </>
  );
}
