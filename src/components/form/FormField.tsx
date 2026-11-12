import * as React from "react";

export interface FormFieldProps {
  label: string;
  htmlFor?: string;
  /** 行内错误；渲染为 role=alert 的 <p>，text-destructive。 */
  error?: string;
  /** 无 error 时的辅助提示行，text-faint。 */
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}

/**
 * DSH 表单字段原语：label 一行（required 加 *）、控件一行、
 * 行内错误（role=alert + text-destructive）或提示行（text-faint）。
 * error 存在时优先于 hint 显示。
 */
export function FormField({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: FormFieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}
