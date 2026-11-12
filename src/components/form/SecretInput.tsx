import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "../../lib/utils";

export interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  /** 已保存密钥的占位提示文案，如「已保存，留空保持不变」。 */
  saved?: string;
  disabled?: boolean;
  /** 校验失败态，透传 aria-invalid。 */
  invalid?: boolean;
  ariaLabel: string;
}

/**
 * DSH ApiKeyInput 交互模式的 write-only 密钥输入框：
 * 默认 password 掩码；reveal 眼睛仅值非空时出现；值一变即重置掩码；
 * onChange 回调去首尾空白；autoComplete=new-password；saved 作 placeholder。
 */
export function SecretInput({
  value,
  onChange,
  saved,
  disabled,
  invalid,
  ariaLabel,
}: SecretInputProps) {
  const [revealed, setRevealed] = React.useState(false);

  // 值变更即重置 reveal（DSH：任何编辑后重新掩码）。
  React.useEffect(() => {
    setRevealed(false);
  }, [value]);

  return (
    <div className="relative">
      <input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder={saved}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        autoComplete="new-password"
        className={cn(
          // 沿用 ui/input 的既有类（复制而非导入，保持原语自包含），
          // 加 font-mono 密钥等宽与 pr-10 给 reveal 按钮留位。
          "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pr-10 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
        )}
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label={revealed ? "隐藏密钥" : "显示密钥"}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((r) => !r)}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-50"
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}
