/**
 * Price comparisons. Pure functions over API shapes, so they can be tested
 * without a browser. Every price is per unit (a piece, or a kilogram for
 * weighed goods) in minor units, as the server sends it.
 */

import type { PriceAnswer, PriceChange, PriceDecision, Product, ShopPrice } from "./types";

/** What one unit cost on a line, after any discount on it. Mirrors catalog.paid_per_unit. */
export function paidPerUnit(total: number, quantity?: string | number | null): number {
  const q = Number(quantity ?? 1);
  if (!Number.isFinite(q) || q <= 0) return total;
  return Math.round(total / q);
}

/** `price` against `reference`: positive means dearer. Percent is null with no reference. */
export function priceGap(price: number, reference: number): { diff: number; percent: number | null } {
  const diff = price - reference;
  return { diff, percent: reference > 0 ? (diff / reference) * 100 : null };
}

/** Rows with a price today, cheapest first. */
export function pricedRows(product: Pick<Product, "prices">): ShopPrice[] {
  return product.prices
    .filter((row): row is ShopPrice & { price: number } => row.price !== null)
    .sort((a, b) => a.price! - b.price!);
}

export type LineVerdict =
  /** Nowhere else is known to sell it: nothing to compare with. */
  | { kind: "unknown" }
  /** Cheaper than every other known shop, by `diff` per unit. */
  | { kind: "cheapest"; diff: number; percent: number | null; next: ShopPrice }
  /** `shop` sells it for `diff` less per unit. */
  | { kind: "dearer"; diff: number; percent: number | null; shop: ShopPrice }
  | { kind: "same"; shop: ShopPrice };

/** How a price paid at `shopId` compares with the cheapest other shop. */
export function compareWithOtherShops(
  paid: number,
  product: Pick<Product, "prices">,
  shopId: string | null,
): LineVerdict {
  const other = pricedRows(product).find((row) => row.shop_id !== shopId);
  if (!other) return { kind: "unknown" };
  const { diff, percent } = priceGap(paid, other.price!);
  if (diff > 0) return { kind: "dearer", diff, percent, shop: other };
  if (diff < 0) return { kind: "cheapest", diff: -diff, percent: percent === null ? null : -percent, next: other };
  return { kind: "same", shop: other };
}

export interface BasketLine {
  productId: string | null;
  quantity?: string | number | null;
  /** What was paid for the line here. */
  total: number;
}

export interface BasketShop {
  shopId: string;
  shopName: string;
  /** Lines this shop has a price for; the comparison covers only those. */
  covered: number;
  /** Paid here for those lines. */
  here: number;
  /** The same lines at that shop's price today. */
  there: number;
  /** there - here: negative means that shop is cheaper for these lines. */
  diff: number;
}

/**
 * The same basket at every other shop with a price for any of it. Each shop
 * is compared only on the lines it prices -- a shop that sells three of the
 * twelve things is not "cheaper" because the other nine are missing.
 * Ordered by the biggest saving first.
 */
export function basketElsewhere(
  lines: BasketLine[],
  products: ReadonlyMap<string, Pick<Product, "prices">>,
  shopId: string | null,
): BasketShop[] {
  const shops = new Map<string, BasketShop>();
  for (const line of lines) {
    const product = line.productId ? products.get(line.productId) : undefined;
    if (!product || line.total <= 0) continue;
    const quantity = Number(line.quantity ?? 1) > 0 ? Number(line.quantity ?? 1) : 1;
    for (const row of product.prices) {
      if (row.price === null || row.shop_id === shopId) continue;
      const entry = shops.get(row.shop_id) ?? {
        shopId: row.shop_id, shopName: row.shop_name, covered: 0, here: 0, there: 0, diff: 0,
      };
      entry.covered += 1;
      entry.here += line.total;
      entry.there += Math.round(row.price * quantity);
      entry.diff = entry.there - entry.here;
      shops.set(row.shop_id, entry);
    }
  }
  return [...shops.values()].sort((a, b) => a.diff - b.diff || b.covered - a.covered);
}

/**
 * A receipt against the usual prices known now: each good's regular price
 * averaged over the shops that have one. Mirrors the server's savings sum,
 * minus its time window -- a receipt being entered is about today anyway.
 * Lines with no known regular price are left out (`compared` says how many
 * were in).
 */
export function receiptVsUsual(
  lines: BasketLine[],
  products: ReadonlyMap<string, Pick<Product, "prices">>,
): { saved: number; compared: number } {
  let saved = 0;
  let compared = 0;
  for (const line of lines) {
    const product = line.productId ? products.get(line.productId) : undefined;
    const regulars = (product?.prices ?? []).flatMap((row) => (row.regular_price ? [row.regular_price] : []));
    if (!regulars.length || line.total <= 0) continue;
    const usual = regulars.reduce((a, b) => a + b, 0) / regulars.length;
    const quantity = Number(line.quantity ?? 1) > 0 ? Number(line.quantity ?? 1) : 1;
    saved += Math.round(usual * quantity) - line.total;
    compared += 1;
  }
  return { saved, compared };
}

/**
 * Whether another shop is worth a trip for a basket: a real share of what
 * was paid for those items, across more than a couple of them. A few roubles
 * on a toothpick is true but not useful.
 */
export const TRIP_MIN_PERCENT = 10;
export const TRIP_MIN_ITEMS = 3;

export function worthATrip(shop: BasketShop): boolean {
  return shop.diff < 0 && shop.covered >= TRIP_MIN_ITEMS && -shop.diff / Math.max(shop.here, 1) * 100 >= TRIP_MIN_PERCENT;
}

/** Whole days from `today` to `until` (both YYYY-MM-DD); negative once past. */
export function daysUntil(until: string, today: string): number {
  const ms = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** The ISO date `days` after `from`. */
export function addDaysIso(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Lowest and highest price today across shops, or null with fewer than two. */
export function priceSpread(product: Pick<Product, "prices">): { min: number; max: number } | null {
  const rows = pricedRows(product);
  if (rows.length < 2) return null;
  return { min: rows[0].price!, max: rows[rows.length - 1].price! };
}

/** How long a sale is assumed to run when nobody says; mirrors catalog.SALE_DAYS. */
export const SALE_DAYS = 7;

/** A jump this big is likelier a misread than a new price, so the default is to keep. */
const SUSPICIOUS_PERCENT = 60;

/**
 * The answer pre-selected for a changed price: a discounted line is a sale,
 * an implausible jump is kept, anything else is the shop's new price.
 */
export function defaultDecision(change: PriceChange): PriceDecision {
  if (change.on_sale) return "sale";
  if (change.saved_price) {
    const { percent } = priceGap(change.price, change.saved_price);
    if (percent !== null && Math.abs(percent) >= SUSPICIOUS_PERCENT) return "keep";
  }
  return "regular";
}

export function initialAnswers(changes: PriceChange[]): PriceAnswer[] {
  return changes.map((change) => ({
    change,
    decision: defaultDecision(change),
    saleUntil: addDaysIso(change.observed_on, SALE_DAYS),
  }));
}
