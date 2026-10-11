/**
 * How prices compare between shops.
 *
 * The house rules from charts.tsx hold: one measure per chart, thin marks,
 * every value written out so nothing hides behind a hover. Green marks the
 * cheaper side and red paying more -- the spending pair -- and neither is ever
 * alone: a signed amount and a word ("cheapest", "more") always ride along.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { smoothChartPath } from "../lib/chart-path";
import { exponentFor, formatMoney } from "../lib/money";
import { formatPercent, shortDate } from "../lib/price-format";
import { compactMoney } from "../lib/spending-format";
import {
  compareWithOtherShops, daysUntil, pricedRows, worthATrip,
  TRIP_MIN_ITEMS, TRIP_MIN_PERCENT, type BasketShop, type LineVerdict,
} from "../lib/prices";
import type { PricePoint, Product, ShopPrice } from "../lib/types";
import { Money, cx } from "./ui";

/* ------------------------------------------------------------ line verdict */

/**
 * One line of a receipt against the cheapest other shop. Per unit, because a
 * line of 2 kg and a shelf price per kilogram must compare like for like.
 */
export function PriceVerdict({
  paid,
  product,
  shopId,
  currency,
  className,
}: {
  paid: number;
  product: Pick<Product, "prices">;
  shopId: string | null;
  currency: string;
  className?: string;
}) {
  const { t, language } = useI18n();
  const verdict: LineVerdict = compareWithOtherShops(paid, product, shopId);
  if (verdict.kind === "unknown") return null;
  const chip = "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";
  if (verdict.kind === "same") {
    return (
      <span className={cx(chip, "bg-surface-2 text-muted", className)}>
        {t("Same price at {shop}", { shop: verdict.shop.shop_name })}
      </span>
    );
  }
  const percent = verdict.percent === null ? "" : ` (${formatPercent(verdict.percent, language)}%)`;
  // Paying a little more than somewhere else is information, not a mistake:
  // nobody crosses town for one item. So it stays neutral, and only a good
  // buy gets colour.
  return verdict.kind === "dearer" ? (
    <span className={cx(chip, "bg-surface-2 font-normal text-muted", className)}>
      <span className="truncate">
        {t("{amount} less at {shop}", {
          amount: formatMoney(verdict.diff, currency) + percent,
          shop: verdict.shop.shop_name,
        })}
      </span>
    </span>
  ) : (
    <span className={cx(chip, "bg-price-low-soft text-price-low", className)}>
      <span aria-hidden="true">↓</span>
      <span className="truncate">
        {t("Cheapest known · {amount} less than at {shop}", {
          amount: formatMoney(verdict.diff, currency) + percent,
          shop: verdict.next.shop_name,
        })}
      </span>
    </span>
  );
}

/* --------------------------------------------------------- per-shop bars */

/**
 * Emphasis: the cheapest shop in green, the rest neutral. Bars start at zero,
 * so a 10% difference looks like 10%; the signed gap beside each bar is what
 * makes small differences readable. A running sale draws its regular price as
 * a faint extension, so "how much cheaper than usual" is visible too.
 */
export function ShopPriceBars({
  product,
  currency,
  today,
  highlightShopId,
  onEdit,
  editing,
}: {
  product: Pick<Product, "prices">;
  currency: string;
  today: string;
  /** The shop a purchase was made in, marked "here". */
  highlightShopId?: string | null;
  /** Shows an Edit button per shop. */
  onEdit?: (shopId: string) => void;
  /** An editor to open under one shop's row. */
  editing?: { shopId: string; node: ReactNode } | null;
}) {
  const { t, language } = useI18n();
  const rows = pricedRows(product);
  const unpriced = product.prices.filter((row) => row.price === null);
  if (rows.length === 0 && unpriced.length === 0) return null;
  const best = rows[0]?.price ?? 0;
  const scale = Math.max(1, ...rows.map((row) => Math.max(row.price!, row.on_sale ? row.regular_price ?? 0 : 0)));

  return (
    <div>
      <ul className="flex flex-col gap-3.5">
        {rows.map((row, index) => {
          const price = row.price!;
          const cheapest = index === 0 || price === best;
          const gap = price - best;
          const regular = row.on_sale && row.regular_price && row.regular_price > price ? row.regular_price : null;
          return (
            <li key={row.shop_id}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-body">
                  <span className="truncate">{row.shop_name}</span>
                  {row.shop_id === highlightShopId && <span className="text-[12px] text-subtle">{t("here")}</span>}
                  {row.on_sale && <SaleChip until={row.sale_until} today={today} />}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <Money minor={price} currency={currency} className="text-sm font-medium" />
                  <span className={cx("text-[12px]", cheapest ? "font-medium text-price-low" : "text-muted")}>
                    {cheapest
                      ? t("cheapest")
                      : `+${formatMoney(gap, currency)} (+${formatPercent((gap / Math.max(best, 1)) * 100, language)}%)`}
                  </span>
                  {onEdit && <EditButton label={t("Edit price at {shop}", { shop: row.shop_name })} onClick={() => onEdit(row.shop_id)} />}
                </span>
              </div>
              <div
                className="track relative h-2 w-full rounded-full bg-surface-2"
                title={regular ? t("{price} on sale, usually {regular}", {
                  price: formatMoney(price, currency), regular: formatMoney(regular, currency),
                }) : undefined}
              >
                {regular && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-r-[4px] bg-surface-3"
                    style={{ width: `${(regular / scale) * 100}%` }}
                  />
                )}
                <div
                  className={cx(
                    "absolute inset-y-0 left-0 rounded-r-[4px]",
                    cheapest ? "bg-price-low-mark" : "bg-chart-bar opacity-70",
                  )}
                  style={{ width: `${Math.max((price / scale) * 100, 1.5)}%` }}
                />
              </div>
              {regular && (
                <p className="mt-1 text-[12px] text-muted">
                  {t("usually {price}", { price: formatMoney(regular, currency) })}
                </p>
              )}
              {editing?.shopId === row.shop_id && <div className="mt-3">{editing.node}</div>}
            </li>
          );
        })}
      </ul>
      {unpriced.length > 0 && (onEdit ? (
        <ul className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          {unpriced.map((row) => (
            <li key={row.shop_id}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate text-body">{row.shop_name}</span>
                <span className="flex shrink-0 items-baseline gap-2 text-muted">
                  {row.last_paid !== null
                    ? t("no current price · last paid {price}", { price: formatMoney(row.last_paid, currency) })
                    : t("no current price")}
                  <EditButton label={t("Set price at {shop}", { shop: row.shop_name })} onClick={() => onEdit(row.shop_id)} />
                </span>
              </div>
              {editing?.shopId === row.shop_id && <div className="mt-3">{editing.node}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[12px] text-muted">
          {t("No current price at {shops}.", { shops: unpriced.map((row) => row.shop_name).join(", ") })}
        </p>
      ))}
    </div>
  );
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" aria-label={label} onClick={onClick}
      className={cx(
        "-my-1 rounded-control px-1.5 py-1 text-[12px] font-medium text-muted underline-offset-2",
        "transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2 active:duration-0 pointer-coarse:px-2.5 pointer-coarse:py-2",
      )}>
      {t("Edit")}
    </button>
  );
}

export function SaleChip({ until, today }: { until: string | null; today: string }) {
  const { t } = useI18n();
  const left = until ? daysUntil(until, today) : null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-price-low-soft px-1.5 py-px text-[11px] font-medium text-price-low">
      {left === null ? t("sale") : left <= 0 ? t("sale · last day") : t("sale · {count} d left", { count: left })}
    </span>
  );
}

/* ------------------------------------------------------ basket comparison */

/**
 * How a receipt did. First what it saved (or cost) against the usual prices,
 * then the same lines at other shops as a diverging bar around "what you
 * paid": left and green is cheaper there, right and red is dearer. Another
 * shop is only suggested when the saving is worth a trip -- a real share of
 * the bill over several items -- because a few roubles on one thing is not.
 */
export function BasketComparison({
  shops,
  tracked,
  currency,
  shopName,
  vsUsual,
}: {
  shops: BasketShop[];
  /** Lines linked to a product at all; the "of N" in "3 of 5 items". */
  tracked: number;
  currency: string;
  shopName: string | null;
  vsUsual: { saved: number; compared: number };
}) {
  const { t, language } = useI18n();
  const scale = Math.max(1, ...shops.map((shop) => Math.abs(shop.diff)));
  const trip = shops.find(worthATrip);
  const pct = (shop: BasketShop) => (shop.here > 0 ? (shop.diff / shop.here) * 100 : 0);

  return (
    <div>
      {vsUsual.compared > 0 && vsUsual.saved !== 0 && (
        <p className="mb-3 flex flex-wrap items-baseline gap-x-2 text-sm text-body">
          <span className={cx(
            "rounded-full px-2 py-0.5 text-[13px] font-medium",
            vsUsual.saved > 0 ? "bg-price-low-soft text-price-low" : "bg-surface-2 text-muted",
          )}>
            {vsUsual.saved > 0
              ? t("Saved {amount}", { amount: formatMoney(vsUsual.saved, currency) })
              : t("{amount} over usual", { amount: formatMoney(-vsUsual.saved, currency) })}
          </span>
          <span className="text-[13px] text-muted">
            {t("against the usual prices of {count} of these items", { count: vsUsual.compared })}
          </span>
        </p>
      )}
      {shops.length > 0 && (
        <p className="mb-3 text-sm text-body">
          {trip
            ? t("{count} of these items would have cost {amount} less at {shop}.", {
                count: trip.covered, amount: formatMoney(-trip.diff, currency), shop: trip.shopName,
              })
            : shopName
              ? t("No other shop is cheaper enough to be worth a trip from {shop}.", { shop: shopName })
              : t("No other shop is cheaper enough to be worth a trip.")}
        </p>
      )}
      {shops.length > 0 && <>
      <div className="mb-2 flex items-center justify-between text-[11px] text-subtle">
        <span>{t("cheaper there")}</span>
        <span>{t("what you paid")}</span>
        <span>{t("dearer there")}</span>
      </div>
      <ul className="flex flex-col gap-3">
        {shops.map((shop) => {
          const fraction = Math.abs(shop.diff) / scale;
          return (
            <li key={shop.shopId}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="min-w-0 truncate text-sm text-body">
                  {shop.shopName}
                  <span className="ml-1.5 text-[12px] text-muted">
                    {t("{count} of {total} items", { count: shop.covered, total: tracked })}
                  </span>
                </span>
                <span className={cx(
                  "shrink-0 text-[13px] font-medium",
                  shop.diff < 0 ? "text-price-low" : shop.diff > 0 ? "text-price-high" : "text-muted",
                )}>
                  {shop.diff === 0
                    ? t("same")
                    : t(shop.diff < 0 ? "{amount} less ({percent}%)" : "{amount} more ({percent}%)", {
                        amount: formatMoney(Math.abs(shop.diff), currency),
                        percent: formatPercent(pct(shop), language),
                      })}
                </span>
              </div>
              <div className="track relative h-2 w-full rounded-full bg-surface-2"
                title={t("{paid} here, {there} there", {
                  paid: formatMoney(shop.here, currency), there: formatMoney(shop.there, currency),
                })}>
                <div className="absolute inset-y-[-3px] left-1/2 w-px -translate-x-1/2 bg-line-strong" />
                {shop.diff !== 0 && (
                  <div
                    className={cx(
                      "absolute top-0 h-2",
                      shop.diff < 0
                        ? "right-1/2 rounded-l-[4px] bg-price-low-mark"
                        : "left-1/2 rounded-r-[4px] bg-price-high-mark",
                    )}
                    style={{ width: `${Math.max(fraction * 50, 1.5)}%` }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-muted">
        {t("Compared at each shop's current price, only for the items it has a price for. A trip is suggested from {percent}% less on {count} or more items.", {
          percent: TRIP_MIN_PERCENT, count: TRIP_MIN_ITEMS,
        })}
      </p>
      </>}
    </div>
  );
}

/* --------------------------------------------------------- price history */

const DAY_MS = 86_400_000;

/**
 * What was paid over time, drawn the way the Spending tab draws money: the
 * same monotone spline, axis and readout. One shop is the selected line --
 * purple, filled -- and the others are the dashed "previous" lines, so shops
 * never need a colour each; the chips above choose which one leads. Hollow
 * dots on the selected line are purchases made on sale. Pointing anywhere
 * reads out every shop's price on that date underneath.
 */
export function PriceHistory({
  history,
  prices,
  currency,
}: {
  history: PricePoint[];
  prices: ShopPrice[];
  currency: string;
}) {
  const { t, language } = useI18n();
  const id = useId().replace(/:/g, "");
  const scroller = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(800);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setChartWidth(Math.max(240, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const series = useMemo(() => {
    const groups = new Map<string, { shopId: string; name: string; points: PricePoint[] }>();
    for (const point of history) {
      if (!point.shop_id) continue;
      const group = groups.get(point.shop_id) ?? { shopId: point.shop_id, name: point.shop_name ?? "", points: [] };
      // One point a day: the spline needs x to increase, and a day is the grain.
      const last = group.points[group.points.length - 1];
      if (last?.spent_at === point.spent_at) group.points[group.points.length - 1] = point;
      else group.points.push(point);
      groups.set(point.shop_id, group);
    }
    // Same order as the bars above: cheapest shop today first.
    const order = new Map(prices.map((row, i) => [row.shop_id, i]));
    return [...groups.values()].sort((a, b) => (order.get(a.shopId) ?? 99) - (order.get(b.shopId) ?? 99));
  }, [history, prices]);
  const [chosen, setChosen] = useState<string | null>(null);
  const lead = series.find((s) => s.shopId === chosen) ?? series[0];
  const dates = useMemo(
    () => [...new Set(series.flatMap((s) => s.points.map((p) => p.spent_at)))].sort(),
    [series],
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (!lead) return null;

  const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const first = at(dates[0]) - (dates.length === 1 ? 15 * DAY_MS : 0);
  const last = at(dates[dates.length - 1]) + (dates.length === 1 ? 15 * DAY_MS : 0);
  const values = series.flatMap((s) => s.points.map((p) => p.price));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const pad = Math.max(10 ** exponentFor(currency), (high - low) * 0.2);
  const min = Math.max(0, low - pad);
  const max = high + pad;
  const left = 80, right = chartWidth - 20, top = 18, bottom = 222;
  const x = (iso: string) => left + (at(iso) - first) / Math.max(1, last - first) * (right - left);
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const pathOf = (points: PricePoint[]) => smoothChartPath(points.map((p) => ({ x: x(p.spent_at), y: y(p.price) })));
  const leadPoints = lead.points;
  const area = leadPoints.length > 1
    ? `${pathOf(leadPoints)} L${x(leadPoints[leadPoints.length - 1].spent_at)},${bottom} L${x(leadPoints[0].spent_at)},${bottom} Z`
    : "";
  const ticks = Array.from({ length: 4 }, (_, i) => min + (max - min) * i / 3);
  const labelEvery = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor((right - left) / 90))));
  const focus = selected ?? dates[dates.length - 1];
  /** Each shop's latest purchase on or before a date. */
  const priceOn = (points: PricePoint[], iso: string) => [...points].reverse().find((p) => p.spent_at <= iso);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Selected shop")}>
        {series.map((s) => {
          const on = s.shopId === lead.shopId;
          return (
            <button key={s.shopId} type="button" aria-pressed={on} onClick={() => setChosen(s.shopId)}
              className={cx(
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] transition-colors pointer-coarse:h-10",
                on ? "border-line-strong bg-surface-2 font-medium text-body" : "border-line text-muted hover:text-body",
              )}>
              {on ? <span className="h-0.5 w-4 bg-chart-spending" /> : <span className="w-4 border-t-2 border-dashed border-muted" />}
              {s.name}
            </button>
          );
        })}
        <span className="ml-auto text-[12px] text-muted">{currency} · {t("per unit")}</span>
      </div>
      <div ref={scroller} className="overflow-x-auto">
        <svg viewBox={`0 0 ${chartWidth} 258`} className="block w-full min-w-[240px]" role="group" aria-label={t("Price history chart")}>
          <title>{t("Price history chart")}</title>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-spending)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--chart-spending)" stopOpacity="0.02" />
            </linearGradient>
            <pattern id={`${id}-dots`} width="7" height="7" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="0.85" fill="var(--chart-spending)" opacity="0.35" />
            </pattern>
          </defs>
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
              <text x={left - 12} y={y(tick) + 4} textAnchor="end" fill="var(--text-muted)" fontSize="11">{compactMoney(tick, currency, language)}</text>
            </g>
          ))}
          {area && <path d={area} fill={`url(#${id}-fill)`} />}
          {area && <path d={area} fill={`url(#${id}-dots)`} />}
          {series.filter((s) => s !== lead && s.points.length > 1).map((s) => (
            <path key={s.shopId} d={pathOf(s.points)} fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="5 5" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.filter((s) => s !== lead && s.points.length === 1).map((s) => (
            <circle key={s.shopId} cx={x(s.points[0].spent_at)} cy={y(s.points[0].price)} r="3.5" fill="var(--surface)" stroke="var(--text-muted)" strokeWidth="2" />
          ))}
          {leadPoints.length > 1 && (
            <path d={pathOf(leadPoints)} fill="none" stroke="var(--chart-spending)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          )}
          {leadPoints.map((p) => (
            <circle key={p.spent_at} cx={x(p.spent_at)} cy={y(p.price)} r={p.spent_at === focus ? 4.5 : 3}
              fill={p.on_sale ? "var(--surface)" : "var(--chart-spending)"} stroke={p.on_sale ? "var(--chart-spending)" : "var(--surface)"} strokeWidth="2" />
          ))}
          <line x1={x(focus)} x2={x(focus)} y1={top} y2={bottom} stroke="var(--border-strong)" strokeDasharray="3 4" />
          {dates.map((date, i) => {
            const prev = dates[i - 1], next = dates[i + 1];
            const from = prev ? (x(prev) + x(date)) / 2 : left - 8;
            const to = next ? (x(date) + x(next)) / 2 : right + 8;
            return (
              <g key={date}>
                {(i % labelEvery === 0 || i === dates.length - 1) && (
                  <text x={x(date)} y="247" textAnchor="middle" fill="var(--text-muted)" fontSize="11">{shortDate(date, language)}</text>
                )}
                <rect x={from} y={top} width={Math.max(1, to - from)} height={bottom - top} fill="transparent"
                  role="button" tabIndex={0} aria-pressed={focus === date}
                  aria-label={`${shortDate(date, language, true)}: ${series.map((s) => {
                    const p = priceOn(s.points, date);
                    return `${s.name} ${p ? formatMoney(p.price, currency) : "—"}`;
                  }).join("; ")}`}
                  className="cursor-pointer" onMouseEnter={() => setSelected(date)} onFocus={() => setSelected(date)} onClick={() => setSelected(date)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(date); } }} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 rounded-control bg-surface-2 px-3 py-2.5 text-[12px]" aria-live="polite" aria-atomic="true">
        <p className="mb-1.5 text-muted">{shortDate(focus, language, true)}</p>
        <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {series.map((s) => {
            const p = priceOn(s.points, focus);
            return (
              <li key={s.shopId} className="flex min-w-0 items-center gap-2 text-muted">
                {s === lead ? <span className="h-0.5 w-3 shrink-0 bg-chart-spending" /> : <span className="w-3 shrink-0 border-t-2 border-dashed border-muted" />}
                <span className="truncate">{s.name}</span>
                <span className="ml-auto shrink-0 tabular font-medium text-body">{p ? formatMoney(p.price, currency) : "—"}</span>
                {p?.on_sale && <span className="shrink-0 text-price-low">{t("sale")}</span>}
                {p && p.spent_at !== focus && <span className="shrink-0 text-subtle">{shortDate(p.spent_at, language)}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-2 text-[11px] text-muted">{t("Each shop shows the last price paid on or before that day. Hollow dots were bought on sale.")}</p>
    </div>
  );
}
