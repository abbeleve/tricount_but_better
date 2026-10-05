import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSpending } from "../hooks/queries";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { formatMoney } from "../lib/money";
import {
  SPENDING_PERIODS, historyBuckets, periodBuckets, periodStart,
  shiftPeriod, spendingChange, sumSpending, type SpendingPeriod,
} from "../lib/spending";
import type { TeamDetail } from "../lib/types";
import { SpendingComparisonChart, SpendingHistoryChart } from "./SpendingCharts";
import { periodLabel, spendingDate } from "../lib/spending-format";
import { Button, Card, EmptyState, ErrorState, Money, Skeleton, cx } from "./ui";

const LABELS = { week: "Week", month: "Month", year: "Year" };
const CURRENT = { week: "This week", month: "This month", year: "This year" };
const PREVIOUS = { week: "Last week", month: "Last month", year: "Last year" };

function PeriodPicker({ value, onChange, label }: {
  value: SpendingPeriod; onChange: (value: SpendingPeriod) => void; label: string;
}) {
  const { t } = useI18n();
  return <div role="group" aria-label={label} className="inline-flex rounded-segment bg-surface-2 p-1">
    {SPENDING_PERIODS.map((period) => <button key={period} type="button" aria-pressed={value === period}
      onClick={() => onChange(period)} className={cx("rounded-segment-option px-3 py-2 text-[13px] transition-colors",
        value === period ? "bg-raised font-medium text-body shadow-raised" : "text-muted hover:text-body")}>
      {t(LABELS[period])}
    </button>)}
  </div>;
}
function Change({ current, previous }: { current: number; previous: number }) {
  const { t, language } = useI18n();
  const change = spendingChange(current, previous);
  const percent = change === null ? "" : new Intl.NumberFormat(language === "ru" ? "ru-RU" : "en-US", {
    maximumFractionDigits: 1,
  }).format(Math.abs(change));
  const difference = current - previous;
  return <span className={cx(
    "inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium",
    difference > 0 ? "bg-spending-up-soft text-spending-up"
      : difference < 0 ? "bg-spending-down-soft text-spending-down" : "bg-surface-2 text-muted",
  )}>
    {change === null ? t("No previous spending") : change === 0 ? t("No change")
      : t(change > 0 ? "↑ {percent}% more" : "↓ {percent}% less", { percent })}
  </span>;
}

export function SpendingTab({ team }: { team: TeamDetail }) {
  const { t, language } = useI18n();
  const spending = useSpending(team.id);
  const today = todayLocal();
  const [period, setPeriod] = useState<SpendingPeriod>("month");
  const [anchor, setAnchor] = useState(today);
  const [historyPeriod, setHistoryPeriod] = useState<SpendingPeriod>("month");
  const [historyEnd, setHistoryEnd] = useState(today);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const days = spending.data?.days ?? [];
  const currency = spending.data?.currency ?? team.currency;
  const recorded = days.filter((day) => day.date <= today);
  const earliest = recorded[0]?.date ?? today;
  const start = periodStart(anchor, period);
  const end = shiftPeriod(start, period, 1);
  const previousStart = shiftPeriod(start, period, -1);
  const current = sumSpending(days, start, end, today);
  const previous = sumSpending(days, previousStart, start, today);
  const currentBuckets = periodBuckets(days, period, anchor, today);
  const previousBuckets = periodBuckets(days, period, previousStart, today);
  const history = historyBuckets(days, historyPeriod, historyEnd, today);
  const isCurrent = start === periodStart(today, period);
  const canGoBack = start > periodStart(earliest, period);
  const canGoForward = start < periodStart(today, period);
  const count = Math.max(currentBuckets.length, previousBuckets.length);

  function selectPeriod(next: SpendingPeriod, date = today) {
    setPeriod(next);
    setAnchor(date);
  }

  if (spending.isPending) return <div className="flex flex-col gap-4" aria-label={t("Loading spending")} aria-busy="true">
    <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Card key={i} className="p-5"><Skeleton className="mb-4 h-3 w-20" /><Skeleton className="h-8 w-36" /><Skeleton className="mt-3 h-3 w-full" /></Card>)}</div>
    <Card className="p-5"><Skeleton className="mb-6 h-8 w-48" /><Skeleton className="h-64 w-full" /></Card>
  </div>;
  if (spending.isError) return <Card><ErrorState message={t("Could not load spending.")} onRetry={() => spending.refetch()} /></Card>;

  return <div className="flex flex-col gap-4">
    <div className="px-1">
      <h2 className="text-base font-semibold text-body">{t("Spending")}</h2>
      <p className="mt-1 text-[13px] text-muted">{t("Your team's spending, over time.")}</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      {SPENDING_PERIODS.map((item) => {
        const from = periodStart(today, item);
        const to = shiftPeriod(from, item, 1);
        const before = shiftPeriod(from, item, -1);
        const now = sumSpending(days, from, to, today).total;
        const last = sumSpending(days, before, from, today).total;
        return <Card key={item} className={cx("overflow-hidden", item === period && isCurrent && "border-line-strong")}>
          <button type="button" onClick={() => selectPeriod(item)} aria-pressed={period === item && isCurrent}
            className="block w-full p-4 text-left transition-colors hover:bg-surface-2 sm:p-5">
            <span className="block text-[12px] font-medium text-muted">{t(CURRENT[item])}</span>
            <span className="mt-2 block"><Money minor={now} currency={currency} className="break-words text-[24px] font-semibold tracking-tight" /></span>
            <span className="mt-2 block"><Change current={now} previous={last} /></span>
            <span className="mt-3 block text-[12px] text-muted">{t("{period}: {amount}", { period: t(PREVIOUS[item]), amount: formatMoney(last, currency) })}</span>
          </button>
        </Card>;
      })}
    </div>
    <p className="px-1 text-[11px] text-muted">{t("Current totals are through today, compared with the full previous period. Weeks start on Monday.")}</p>
    {recorded.length === 0 && <Card><EmptyState title={t("Nothing spent yet")}
      body={t("Add an expense to start your spending history.")}
      action={<Link to={`/teams/${team.id}/expenses/new`} className="text-sm font-medium underline underline-offset-4">{t("Add expense")}</Link>} /></Card>}

    <div ref={comparisonRef} className="scroll-mt-36">
      <Card className="p-4 sm:p-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-body">{t("Period comparison")}</h3>
          <PeriodPicker value={period} onChange={(next) => selectPeriod(next)} label={t("Comparison period")} />
        </div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-body">{periodLabel(start, end, period, language)}</p>
            <p className="mt-1 text-[12px] text-muted">{t("Compared with {period}", { period: periodLabel(previousStart, start, period, language) })}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled={!canGoBack} aria-label={t("Previous period")} onClick={() => setAnchor(previousStart)}>←</Button>
            <Button variant="secondary" size="sm" disabled={isCurrent} onClick={() => setAnchor(today)}>{t("Current period")}</Button>
            <Button variant="ghost" size="sm" disabled={!canGoForward} aria-label={t("Next period")} onClick={() => setAnchor(shiftPeriod(start, period, 1))}>→</Button>
          </div>
        </div>
        <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Money minor={current.total} currency={currency} className="text-2xl font-semibold" />
          <Change current={current.total} previous={previous.total} />
          <span className="text-[12px] text-muted">{t(current.expenseCount === 1 ? "{count} expense" : "{count} expenses", { count: current.expenseCount })}{isCurrent && ` · ${t("Through {date}", { date: spendingDate(today, language) })}`}</span>
        </div>
        <SpendingComparisonChart key={`${period}-${start}`} current={currentBuckets} previous={previousBuckets} currency={currency} period={period} />
        <details className="mt-5 border-t border-line pt-3">
          <summary className="cursor-pointer text-[12px] font-medium text-muted hover:text-body">{t("View exact amounts")}</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <caption className="sr-only">{t("Spending comparison chart")}</caption>
              <thead className="text-muted"><tr><th className="py-2 pr-3 font-medium">{t("Selected period")}</th><th className="py-2 pr-3 font-medium">{t("Amount")}</th><th className="py-2 pr-3 font-medium">{t("Previous period")}</th><th className="py-2 font-medium">{t("Amount")}</th></tr></thead>
              <tbody className="divide-y divide-line">{Array.from({ length: count }, (_, i) => {
                const a = currentBuckets[i], b = previousBuckets[i];
                const date = (bucket: typeof a) => bucket ? spendingDate(bucket.start, language, period === "year" ? { day: undefined, month: "short", year: "numeric" } : {}) : "—";
                const amount = (bucket: typeof a) => !bucket ? "—" : bucket.total === null ? t("Not yet") : formatMoney(bucket.total, currency);
                return <tr key={i}><td className="whitespace-nowrap py-2 pr-3">{date(a)}</td><td className="whitespace-nowrap py-2 pr-3 tabular">{amount(a)}</td><td className="whitespace-nowrap py-2 pr-3">{date(b)}</td><td className="whitespace-nowrap py-2 tabular">{amount(b)}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </details>
      </Card>
    </div>

    <Card className="p-4 sm:p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-body">{t("Spending history")}</h3>
          <p className="mt-1 text-[12px] text-muted">{t("Choose a bar to explore that period.")}</p></div>
        <PeriodPicker value={historyPeriod} onChange={(next) => { setHistoryPeriod(next); setHistoryEnd(today); }} label={t("History grouping")} />
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted">{periodLabel(history[0].start, history[0].end, historyPeriod, language)} – {periodLabel(history[history.length - 1].start, history[history.length - 1].end, historyPeriod, language)}</p>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={history[0].start <= periodStart(earliest, historyPeriod)} aria-label={t("Older periods")}
            onClick={() => setHistoryEnd(shiftPeriod(historyEnd, historyPeriod, -12))}>←</Button>
          <Button variant="ghost" size="sm" disabled={periodStart(historyEnd, historyPeriod) >= periodStart(today, historyPeriod)} aria-label={t("Newer periods")}
            onClick={() => setHistoryEnd(shiftPeriod(historyEnd, historyPeriod, 12))}>→</Button>
        </div>
      </div>
      <SpendingHistoryChart buckets={history} period={historyPeriod} currency={currency} onSelect={(date) => {
        selectPeriod(historyPeriod, date);
        comparisonRef.current?.scrollIntoView({ block: "start" });
      }} />
      <p className="mt-3 text-[11px] text-muted">{t("Scroll horizontally on smaller screens to see all periods.")}</p>
      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">{t("View history totals")}</summary>
        <ul className="mt-3 divide-y divide-line">{history.map((bucket) => <li key={bucket.start}>
          <button type="button" className="flex w-full items-baseline justify-between gap-3 py-2 text-left text-[12px] hover:text-body"
            onClick={() => { selectPeriod(historyPeriod, bucket.start); comparisonRef.current?.scrollIntoView({ block: "start" }); }}>
            <span className="text-muted">{periodLabel(bucket.start, bucket.end, historyPeriod, language)}</span>
            <Money minor={bucket.total ?? 0} currency={currency} className="shrink-0" />
          </button>
        </li>)}</ul>
      </details>
    </Card>
    <p className="px-1 text-[11px] text-muted">{t("Totals include all team expenses by purchase date, with refunds deducted. Plans and paybacks are excluded.")}</p>
  </div>;
}
