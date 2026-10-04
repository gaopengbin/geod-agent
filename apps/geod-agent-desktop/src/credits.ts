import { getLocale } from "./i18n";

/** Display denomination only. The authoritative wallet continues to settle integer nano-CNY. */
export const CREDITS_PER_CNY = 1_000;
const NANO_CNY_PER_CREDIT = 1_000_000_000n / BigInt(CREDITS_PER_CNY);
export const CREDITS_CHANGED = "geod:credits-changed";

function nano(value: string | null | undefined): bigint | null {
  if (value == null || !/^\d{1,16}$/.test(value)) return null;
  return BigInt(value);
}

/** Balances truncate rather than rounding up; transaction details retain all six decimal places. */
export function formatCredits(value: string | null | undefined, precision: 2 | 6 = 2): string {
  const amount = nano(value);
  if (amount == null) return "—";
  const whole = amount / NANO_CNY_PER_CREDIT;
  const remainder = amount % NANO_CNY_PER_CREDIT;
  const digits = remainder.toString().padStart(6, "0").slice(0, precision).replace(/0+$/, "");
  if (amount > 0n && whole === 0n && !digits) return `<0.01 Credits`;
  const decimal = new Intl.NumberFormat(getLocale()).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(whole)}${digits ? decimal + digits : ""} Credits`;
}

export function formatCreditRate(nanoPerToken: string): string {
  const rate = nano(nanoPerToken);
  return rate == null ? "—" : formatCredits(String(rate * 1_000_000n), 6);
}
