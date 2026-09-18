/**
 * Money helpers. Mirrors the backend's `money.py` exactly.
 *
 * The API speaks integer minor units in both directions. This module is the
 * only place in the frontend that converts to or from a human string, so the
 * rounding rule lives in exactly one spot.
 */

const EXPONENTS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0,
  BHD: 3, KWD: 3, OMR: 3, TND: 3,
};

export function exponentFor(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** "1234.56" -> 123456. Returns null when the text is not a usable amount. */
export function toMinor(input: string, currency: string): number | null {
  const text = input.trim().replace(/\s/g, "").replace(",", ".");
  if (text === "" || !/^-?\d*\.?\d*$/.test(text)) return null;

  const exponent = exponentFor(currency);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");

  // Round half-up on the first discarded digit, matching the server.
  const kept = fraction.slice(0, exponent).padEnd(exponent, "0");
  const next = fraction.charCodeAt(exponent) - 48;
  let value = Number(`${whole || "0"}${kept}`);
  if (Number.isNaN(value)) return null;
  if (next >= 5 && next <= 9) value += 1;

  return negative ? -value : value;
}

/** 123456 -> "1234.56" (plain, for populating an input). */
export function toMajorString(minor: number, currency: string): string {
  const exponent = exponentFor(currency);
  if (exponent === 0) return String(minor);
  const negative = minor < 0;
  const digits = Math.abs(minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** 123456 -> "1 234,56 ₽" using the browser's locale rules. */
export function formatMoney(
  minor: number,
  currency: string,
  options: { signed?: boolean } = {},
): string {
  const exponent = exponentFor(currency);
  const value = minor / 10 ** exponent;
  const formatted = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Math.abs(value));

  if (!options.signed) return value < 0 ? `-${formatted}` : formatted;
  if (minor === 0) return formatted;
  return `${minor > 0 ? "+" : "-"}${formatted}`;
}

/** Splits `total` across `n` people the same way the server does, for previews. */
export function previewEqualSplit(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);

  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);
  const exact = weights.map((w) => (magnitude * w) / sum);
  const shares = exact.map((e) => Math.floor(e));
  let remainder = magnitude - shares.reduce((a, b) => a + b, 0);

  // Largest fractional remainder first; ties break on index, as on the server.
  const order = exact
    .map((e, i) => ({ frac: e - Math.floor(e), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0; k++, remainder--) shares[order[k].i] += 1;
  return shares.map((s) => sign * s);
}
