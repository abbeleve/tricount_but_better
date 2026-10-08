/**
 * Dates are calendar days here, not instants: "when was this bought".
 *
 * `toISOString()` would answer in UTC, so anyone east of Greenwich gets
 * yesterday's date for most of their evening -- in Moscow, every expense added
 * after 03:00 local would be dated a day early.
 */
export function todayLocal(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * "now", "5 minutes ago", "yesterday", "3 days ago" -- then a plain date once
 * it is over a week old. Days count calendar days, so 23:50 seen at 00:10 is
 * "20 minutes ago" and 09:00 yesterday is "yesterday", not "15 hours ago".
 */
export function relativeTime(iso: string, now: Date, locale: string): string {
  const then = new Date(iso);
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return words.format(0, "second");
  if (Math.abs(seconds) < 3600) return words.format(Math.round(seconds / 60), "minute");

  const days = Math.round((startOfDay(then) - startOfDay(now)) / 86_400_000);
  if (days === 0 || Math.abs(seconds) < 6 * 3600) {
    return words.format(Math.round(seconds / 3600), "hour");
  }
  if (Math.abs(days) < 7) return words.format(days, "day");
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: then.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(then);
}
