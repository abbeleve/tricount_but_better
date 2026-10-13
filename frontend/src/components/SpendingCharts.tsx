import { useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { exponentFor, formatMoney } from "../lib/money";
import { smoothChartPath } from "../lib/chart-path";
import { chartDomain, type SpendingBucket, type SpendingPeriod } from "../lib/spending";
import { compactMoney, periodLabel, spendingDate } from "../lib/spending-format";
import { cx } from "./ui";

function bucketLabel(bucket: SpendingBucket, period: SpendingPeriod, language: string) {
  return period === "year"
    ? spendingDate(bucket.start, language, { day: undefined, month: "short" })
    : period === "week"
      ? spendingDate(bucket.start, language, { weekday: "short", day: undefined, month: undefined })
      : bucket.start.slice(8).replace(/^0/, "");
}

/** The chart's drawing width follows its box, so text in the SVG keeps its size. */
function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(240, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function SpendingComparisonChart({ current, previous, currency, period, label }: {
  current: SpendingBucket[]; previous: SpendingBucket[]; currency: string; period: SpendingPeriod;
  /** What the chart shows, for its accessible name; spending by default. */
  label?: string;
}) {
  const { t, language } = useI18n();
  const title = label ?? t("Spending comparison chart");
  const id = useId().replace(/:/g, "");
  const initialSelected = Math.max(0, current.filter((b) => b.total !== null).length - 1);
  const [selected, setSelected] = useState(initialSelected);
  const [scroller, chartWidth] = useChartWidth();
  const count = Math.max(current.length, previous.length);
  const values = [...current, ...previous].map((b) => b.total);
  const domain = chartDomain(values);
  const min = domain.min;
  const max = values.every((value) => value === null || value === 0) ? 10 ** exponentFor(currency) : domain.max;
  const left = 80, right = chartWidth - 20, top = 18, bottom = 222;
  const x = (i: number) => left + i / Math.max(1, count - 1) * (right - left);
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const points = (buckets: SpendingBucket[]) => buckets.flatMap((bucket, i) =>
    bucket.total === null ? [] : [{ x: x(i), y: y(bucket.total) }]);
  const path = (buckets: SpendingBucket[]) => smoothChartPath(points(buckets));
  const currentPoints = points(current);
  const area = currentPoints.length > 0
    ? `${path(current)} L${currentPoints[currentPoints.length - 1].x},${y(0)} L${currentPoints[0].x},${y(0)} Z`
    : "";
  const a = current[selected], b = previous[selected];
  const value = (bucket: SpendingBucket | undefined) => !bucket ? t("No matching day")
    : bucket.total === null ? t("Not yet") : formatMoney(bucket.total, currency);
  const ticks = Array.from({ length: 4 }, (_, i) => min + (max - min) * i / 3);
  const step = period === "month" ? 5 : period === "year" && chartWidth < 480 ? 3 : 1;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[12px] text-muted">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-2"><span className="h-0.5 w-5 bg-chart-spending" />{t("Selected period")}</span>
          <span className="inline-flex items-center gap-2"><span className="w-5 border-t-2 border-dashed border-muted" />{t("Previous period")}</span>
        </div>
        <span>{currency} · {t(period === "year" ? "Monthly totals" : "Daily totals")}</span>
      </div>
      <div ref={scroller} className="overflow-x-auto">
        <svg viewBox={`0 0 ${chartWidth} 258`} className="block w-full min-w-[240px]" role="group" aria-label={title}>
          <title>{title}</title>
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
          {min < 0 && <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />}
          <path d={area} fill={`url(#${id}-fill)`} />
          <path d={area} fill={`url(#${id}-dots)`} />
          <path d={path(previous)} fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="5 5" strokeLinejoin="round" strokeLinecap="round" />
          <path d={path(current)} fill="none" stroke="var(--chart-spending)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {currentPoints.length === 1 && <circle cx={currentPoints[0].x} cy={currentPoints[0].y} r="4" fill="var(--chart-spending)" />}
          <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="var(--border-strong)" strokeDasharray="3 4" />
          {a?.total !== null && a?.total !== undefined && <circle cx={x(selected)} cy={y(a.total)} r="4" fill="var(--chart-spending)" stroke="var(--surface)" strokeWidth="2" />}
          {Array.from({ length: count }, (_, i) => {
            const bucket = current[i] ?? previous[i];
            return (
              <g key={i}>
                {(i % step === 0 || i === count - 1) && <text x={x(i)} y="247" textAnchor="middle" fill="var(--text-muted)" fontSize="11">{bucketLabel(bucket, period, language)}</text>}
                <rect x={Math.max(left - 8, x(i) - (right - left) / (count - 1) / 2)} y={top}
                  width={(right - left) / (count - 1)} height={bottom - top} fill="transparent"
                  role="button" tabIndex={0} aria-pressed={selected === i}
                  aria-label={`${bucketLabel(bucket, period, language)}: ${t("Selected period")} ${value(current[i])}; ${t("Previous period")} ${value(previous[i])}`}
                  className="cursor-pointer [&:focus:not(:focus-visible)]:outline-none" onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => setSelected(i)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(i); } }} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 grid gap-2 rounded-control bg-surface-2 px-3 py-2.5 text-[12px] sm:grid-cols-2" aria-live="polite" aria-atomic="true">
        <p className="min-w-0 text-muted"><span className="mr-2 inline-block size-2 rounded-full bg-chart-spending" />
          {a ? spendingDate(a.start, language, period === "year" ? { day: undefined, month: "long", year: "numeric" } : { year: "numeric" }) : t("No matching day")}
          <span className="ml-2 tabular font-medium text-body">{value(a)}</span>
        </p>
        <p className="min-w-0 text-muted"><span className="mr-2 inline-block w-3 border-t-2 border-dashed border-muted" />
          {b ? spendingDate(b.start, language, period === "year" ? { day: undefined, month: "long", year: "numeric" } : { year: "numeric" }) : t("No matching day")}
          <span className="ml-2 tabular font-medium text-body">{value(b)}</span>
        </p>
      </div>
      <p className="mt-2 text-[11px] text-muted">{t("Tap or focus a point to see exact amounts. Future dates are left blank.")}</p>
    </div>
  );
}

export function SpendingHistoryChart({ buckets, period, currency, onSelect }: {
  buckets: SpendingBucket[]; period: SpendingPeriod; currency: string; onSelect: (start: string) => void;
}) {
  const { t, language } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const firstStart = buckets[0]?.start;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const position = () => { element.scrollLeft = element.scrollWidth; };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => observer.disconnect();
  }, [firstStart]);
  const values = buckets.map((b) => b.total);
  const domain = chartDomain(values);
  const min = domain.min;
  const max = values.every((value) => value === null || value === 0) ? 10 ** exponentFor(currency) : domain.max;
  const y = (value: number) => (max - value) / (max - min) * 100;
  const zero = y(0);
  return (
    <div ref={scroller} className="overflow-x-auto pb-1">
      <div className="relative min-w-[640px] pl-20">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-52">
          {Array.from({ length: 4 }, (_, i) => {
            const value = min + (max - min) * i / 3;
            return <div key={i} className="absolute inset-x-0 flex items-center" style={{ top: `${y(value)}%` }}>
              <span className="sticky left-0 z-10 w-20 shrink-0 bg-surface pr-3 text-right text-[11px] text-muted">{compactMoney(value, currency, language)}</span>
              <span className="h-px flex-1 bg-line" />
            </div>;
          })}
        </div>
        <div className="relative grid grid-cols-12 gap-1 sm:gap-2">
          {buckets.map((bucket) => {
            const amount = bucket.total ?? 0;
            const label = period === "year" ? bucket.start.slice(0, 4)
              : period === "month" ? spendingDate(bucket.start, language, { day: undefined, month: "short" })
                : spendingDate(bucket.start, language);
            return <button key={bucket.start} type="button" onClick={() => onSelect(bucket.start)}
              aria-label={`${periodLabel(bucket.start, bucket.end, period, language)}: ${formatMoney(amount, currency)}. ${t("View period")}`}
              title={`${periodLabel(bucket.start, bucket.end, period, language)}: ${formatMoney(amount, currency)}`}
              className="group min-w-0 rounded-control text-center">
              <span className="relative block h-52">
                <span className={cx("absolute inset-x-[16%] rounded-[3px] bg-chart-spending opacity-65 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100", amount === 0 && "bg-line-strong")}
                  style={{ top: `${Math.min(y(amount), zero)}%`, height: amount === 0 ? "2px" : `${Math.abs(y(amount) - zero)}%` }} />
              </span>
              <span className="mt-3 block truncate text-[11px] text-muted">{label}</span>
              {period !== "year" && <span className="block text-[10px] text-subtle">{bucket.start.slice(0, 4)}</span>}
            </button>;
          })}
        </div>
      </div>
    </div>
  );
}

export interface PersonLine {
  id: string;
  name: string;
  color: string;
  buckets: SpendingBucket[];
}

function historyTick(bucket: SpendingBucket, period: SpendingPeriod, language: string) {
  return period === "year" ? bucket.start.slice(0, 4)
    : period === "month" ? spendingDate(bucket.start, language, { day: undefined, month: "short" })
      : spendingDate(bucket.start, language);
}

/**
 * One line per person over consecutive periods, on one shared scale.
 *
 * Identity is the line's hue, and never only that: the legend names every
 * line, and the caller lists each person's amount for the chosen period.
 * Choosing a column moves the crosshair and tells the caller which period.
 */
export function PeopleSpendingChart({ lines, period, currency, selected, onSelect, label }: {
  lines: PersonLine[]; period: SpendingPeriod; currency: string;
  selected: number; onSelect: (index: number) => void; label: string;
}) {
  const { t, language } = useI18n();
  const [box, chartWidth] = useChartWidth();
  const columns = lines[0]?.buckets ?? [];
  const count = columns.length;
  const values = lines.flatMap((line) => line.buckets.map((b) => b.total));
  const domain = chartDomain(values);
  const min = domain.min;
  const max = values.every((value) => value === null || value === 0) ? 10 ** exponentFor(currency) : domain.max;
  const left = 76, right = chartWidth - 16, top = 14, bottom = 196;
  const gap = (right - left) / Math.max(1, count - 1);
  const x = (i: number) => left + i * gap;
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const ticks = Array.from({ length: 4 }, (_, i) => min + (max - min) * i / 3);
  // Label from the newest period back, so the current one always has its name.
  const step = Math.max(1, Math.ceil((period === "week" ? 50 : 36) / gap));
  const labelled = (i: number) => (count - 1 - i) % step === 0;
  const firstLabelled = columns.findIndex((_, i) => labelled(i));
  const amount = (bucket: SpendingBucket | undefined) => formatMoney(bucket?.total ?? 0, currency);

  return (
    <div>
      {lines.length > 1 && <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-muted" aria-label={t("Legend")}>
        {lines.map((line) => <li key={line.id} className="inline-flex min-w-0 items-center gap-2">
          <span className="h-0.5 w-4 shrink-0 rounded-full" style={{ background: line.color }} />
          <span className="truncate">{line.name}</span>
        </li>)}
      </ul>}
      <div ref={box}>
        <svg viewBox={`0 0 ${chartWidth} 238`} className="block w-full min-w-[240px]" role="group" aria-label={label}>
          <title>{label}</title>
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
              <text x={left - 12} y={y(tick) + 4} textAnchor="end" fill="var(--text-muted)" fontSize="11">{compactMoney(tick, currency, language)}</text>
            </g>
          ))}
          {min < 0 && <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />}
          {count > 0 && <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="var(--border-strong)" strokeDasharray="3 4" />}
          {lines.map((line) => <path key={line.id} fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            d={smoothChartPath(line.buckets.flatMap((b, i) => b.total === null ? [] : [{ x: x(i), y: y(b.total) }]))} />)}
          {lines.map((line) => {
            const value = line.buckets[selected]?.total;
            return value === null || value === undefined ? null
              : <circle key={line.id} cx={x(selected)} cy={y(value)} r="4" fill={line.color} stroke="var(--surface)" strokeWidth="2" />;
          })}
          {columns.map((bucket, i) => {
            const year = bucket.start.slice(0, 4);
            const newYear = period !== "year" && (i === firstLabelled || year !== columns[i - step]?.start.slice(0, 4));
            return (
              <g key={bucket.start}>
                {labelled(i) && <text x={x(i)} y="218" textAnchor="middle" fill={i === selected ? "var(--text)" : "var(--text-muted)"} fontSize="11">{historyTick(bucket, period, language)}</text>}
                {labelled(i) && newYear && <text x={x(i)} y="232" textAnchor="middle" fill="var(--text-subtle)" fontSize="10">{year}</text>}
                <rect x={Math.max(left - 8, x(i) - gap / 2)} y={top} width={gap} height={bottom - top} fill="transparent"
                  role="button" tabIndex={0} aria-pressed={selected === i}
                  aria-label={`${periodLabel(bucket.start, bucket.end, period, language)}: ${lines.map((line) => `${line.name} ${amount(line.buckets[i])}`).join("; ")}`}
                  className="cursor-pointer [&:focus:not(:focus-visible)]:outline-none" onMouseEnter={() => onSelect(i)} onFocus={() => onSelect(i)} onClick={() => onSelect(i)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }} />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
