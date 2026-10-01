import { addDays, type SpendingPeriod } from "./spending";

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
