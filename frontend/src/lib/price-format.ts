/** Locale formatting for price screens. */

export function formatPercent(value: number, language: string): string {
  return new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0,
  }).format(Math.abs(value));
}

export function shortDate(iso: string, language: string, withYear = false): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(language === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
