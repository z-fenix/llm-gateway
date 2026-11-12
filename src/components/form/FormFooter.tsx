import { Button } from "../ui/button";

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
    <div className="flex items-center justify-end gap-3 pt-2">
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
      <Button type="button" disabled={busy || submitDisabled} onClick={onSubmit}>{busy ? busyLabel : submitLabel}</Button>
    </div>
  );
}
