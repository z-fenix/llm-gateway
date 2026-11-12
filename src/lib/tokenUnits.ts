const TOKEN_UNITS = [
  { label: "T", exponent: 12 },
  { label: "B", exponent: 9 },
  { label: "M", exponent: 6 },
  { label: "K", exponent: 3 },
] as const;

/** 显示可缩写，持久化与编辑仍保留完整整数。 */
export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

export function formatTokenInput(value: number | null): string {
  if (value === null) return "";
  const unit = TOKEN_UNITS.find(({ exponent }) => value >= 10 ** exponent);
  if (!unit) return String(value);
  const digits = String(value).padStart(unit.exponent + 1, "0");
  const whole = digits.slice(0, -unit.exponent);
  const fraction = digits.slice(-unit.exponent).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}${unit.label}`;
}

/** 十进制单位；BigInt 换算避免小数误差和缩写编辑时的静默舍入。 */
export function parseTokenAmount(raw: string): number | null | "invalid" {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 80) return "invalid";
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([KMBT万亿]?)$/i.exec(value);
  if (!match) return "invalid";
  const [, whole, fraction = "", suffix] = match;
  const exponent = ({ K: 3, M: 6, B: 9, T: 12, 万: 4, 亿: 8 } as Record<string, number>)[suffix.toUpperCase()] ?? 0;
  const numerator = BigInt(whole.replace(/,/g, "") + fraction) * 10n ** BigInt(exponent);
  const divisor = 10n ** BigInt(fraction.length);
  if (numerator % divisor !== 0n) return "invalid";
  const result = numerator / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return "invalid";
  return Number(result);
}
