import type { DailySpending, PersonSpending } from "./types";

export type SpendingPeriod = "week" | "month" | "year";
export const SPENDING_PERIODS: SpendingPeriod[] = ["week", "month", "year"];

export interface SpendingBucket {
  start: string;
  end: string;
  // A future bucket is unknown, rather than a day with zero spending.
  total: number | null;
  expenseCount: number;
}

// UTC is used only for arithmetic on date-only values, avoiding DST gaps.
// The caller supplies today's date from the viewer's local calendar.
function calendarDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
export function addDays(value: string, amount: number): string {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return iso(date);
}
export function periodStart(value: string, period: SpendingPeriod): string {
  const date = calendarDate(value);
  if (period === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (period === "month") date.setUTCDate(1);
  if (period === "year") date.setUTCMonth(0, 1);
  return iso(date);
}
export function shiftPeriod(start: string, period: SpendingPeriod, amount: number): string {
  const date = calendarDate(periodStart(start, period));
  if (period === "week") date.setUTCDate(date.getUTCDate() + amount * 7);
  if (period === "month") date.setUTCMonth(date.getUTCMonth() + amount);
  if (period === "year") date.setUTCFullYear(date.getUTCFullYear() + amount);
  return iso(date);
}
export function sumSpending(days: DailySpending[], start: string, end: string, today: string) {
  let total = 0;
  let expenseCount = 0;
  for (const day of days) {
    if (day.date >= start && day.date < end && day.date <= today) {
      total += day.total;
      expenseCount += day.expense_count;
    }
  }
  return { total, expenseCount };
}
export function periodBuckets(
  days: DailySpending[], period: SpendingPeriod, anchor: string, today: string,
): SpendingBucket[] {
  const start = periodStart(anchor, period);
  const end = shiftPeriod(start, period, 1);
  const buckets: SpendingBucket[] = [];
  for (let cursor = start; cursor < end;) {
    const next = period === "year" ? shiftPeriod(cursor, "month", 1) : addDays(cursor, 1);
    const value = sumSpending(days, cursor, next, today);
    buckets.push({ start: cursor, end: next, total: cursor > today ? null : value.total, expenseCount: value.expenseCount });
    cursor = next;
  }
  return buckets;
}
export function historyBuckets(
  days: DailySpending[], period: SpendingPeriod, last: string, today: string, count = 12,
): SpendingBucket[] {
  const end = periodStart(last, period);
  return Array.from({ length: count }, (_, i) => {
    const start = shiftPeriod(end, period, i - count + 1);
    const next = shiftPeriod(start, period, 1);
    const value = sumSpending(days, start, next, today);
    return { start, end: next, total: start > today ? null : value.total, expenseCount: value.expenseCount };
  });
}
export function spendingChange(current: number, previous: number): number | null {
  return previous === 0 ? (current === 0 ? 0 : null) : (current - previous) / Math.abs(previous) * 100;
}
export function chartDomain(values: (number | null)[]): { min: number; max: number } {
  const known = values.filter((value): value is number => value !== null);
  const min = Math.min(0, ...known);
  const max = Math.max(0, ...known);
  return { min: min < 0 ? min * 1.15 : 0, max: max > 0 ? max * 1.15 : min === 0 ? 1 : 0 };
}

/** Who paid at the till, or whose share it was. Across everyone, either adds up to the team's spending. */
export type SpendingMeasure = "paid" | "share";
export const SPENDING_MEASURES: SpendingMeasure[] = ["share", "paid"];

/** Periods to show up to `last`: back to the first purchase, so a young team's
 * chart is not mostly empty, but at least two, so every line has two ends. */
export function historyLength(earliest: string, last: string, period: SpendingPeriod, max = 12): number {
  const first = periodStart(earliest, period);
  let start = periodStart(last, period);
  let count = 1;
  while (count < max && start > first) {
    start = shiftPeriod(start, period, -1);
    count++;
  }
  return Math.max(2, count);
}

export interface SpendingSeries {
  /** A user id, or "others" for everyone folded together past the last hue. */
  id: string;
  name: string;
  isMember: boolean;
  days: DailySpending[];
}

/** One series per person, in the order given, so each keeps its hue. There are
 * `limit` hues and they are never reused: with more people than that, the
 * last hue's place goes to everyone from there on, as one "others" series. */
export function personSeries(people: PersonSpending[], measure: SpendingMeasure, limit = 8): SpendingSeries[] {
  const series = people.map((person) => ({
    id: person.user_id, name: person.display_name, isMember: person.is_member, days: person[measure],
  }));
  if (series.length <= limit) return series;
  const rest = series.slice(limit - 1);
  return [...series.slice(0, limit - 1), {
    id: "others", name: "", isMember: true, days: rest.flatMap((person) => person.days),
  }];
}
