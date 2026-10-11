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

/** A pack size in grams, millilitres or pieces; the larger unit from 1000 up: "1,5 кг". */
export function formatPackSize(size: string, unit: "g" | "ml" | "pcs", language: string): string {
  const locale = language === "ru" ? "ru-RU" : "en-US";
  const value = Number(size);
  if (unit === "pcs") {
    return `${new Intl.NumberFormat(locale).format(value)} ${language === "ru" ? "шт." : "pcs"}`;
  }
  const large = value >= 1000;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: unit === "g" ? (large ? "kilogram" : "gram") : large ? "liter" : "milliliter",
    unitDisplay: "short",
    maximumFractionDigits: 3,
  }).format(large ? value / 1000 : value);
}
