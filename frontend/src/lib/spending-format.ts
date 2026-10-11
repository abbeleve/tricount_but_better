import { exponentFor } from "./money";
import { addDays, type SpendingPeriod } from "./spending";

/** Axis labels: "1,2 тыс. ₽" rather than every digit. */
export function compactMoney(minor: number, currency: string, language: string) {
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    style: "currency", currency, notation: "compact", maximumFractionDigits: 1,
  }).format(minor / 10 ** exponentFor(currency));
}

export function spendingDate(value: string, language: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
    timeZone: "UTC", day: "numeric", month: "short", ...options,
  }).format(new Date(`${value}T00:00:00Z`));
}
export function periodLabel(start: string, end: string, period: SpendingPeriod, language: string): string {
  if (period === "year") return start.slice(0, 4);
  if (period === "month") return spendingDate(start, language, { day: undefined, month: "long", year: "numeric" });
  return `${spendingDate(start, language, { year: "numeric" })} – ${spendingDate(addDays(end, -1), language, { year: "numeric" })}`;
}
