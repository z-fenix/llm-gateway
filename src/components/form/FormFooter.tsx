import { cn } from "../../lib/utils";

export interface FormFooterProps {
  onCancel: () => void;
  onSubmit: () => void;
  busy?: boolean;
  submitDisabled?: boolean;
  cancelLabel?: string;
  submitLabel?: string;
  busyLabel?: string;
}

/**
 * DSH EditorFooter 语义的表单页脚：左取消右应用。
 * cancel 仅 busy 时禁用；submit 在 busy || submitDisabled 时禁用，
 * 文案 busy ? busyLabel : submitLabel。两按钮均 type=button。
 */
export function FormFooter({
  onCancel,
  onSubmit,
  busy = false,
  submitDisabled = false,
  cancelLabel = "取消",
  submitLabel = "应用",
  busyLabel = "应用中",
}: FormFooterProps) {
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className={cn(
          "inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors",
          "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        disabled={busy || submitDisabled}
        onClick={onSubmit}
        className={cn(
          "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors",
          "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
          "disabled:pointer-events-none disabled:opacity-50"
        )}
      >
        {busy ? busyLabel : submitLabel}
      </button>
    </div>
  );
}
