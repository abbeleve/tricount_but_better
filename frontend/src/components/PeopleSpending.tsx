import { useState } from "react";
import { usePeopleSpending } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { exponentFor, formatMoney, previewEqualSplit } from "../lib/money";
import {
  SPENDING_MEASURES, periodBuckets, periodStart, personSeries, shiftPeriod, sumSpending,
  type SpendingMeasure, type SpendingPeriod,
} from "../lib/spending";
import { periodLabel, spendingDate } from "../lib/spending-format";
import type { TeamDetail } from "../lib/types";
import { PeriodPicker, Segmented } from "./Segmented";
import { PeopleSpendingChart, SpendingChange, SpendingComparisonChart } from "./SpendingCharts";
import { Button, Card, ErrorState, Money, Skeleton, cx } from "./ui";

const MEASURES = { paid: "Who paid", share: "Who it was for" };
const EXPLAINED = {
  paid: "How much each person paid themselves, whoever it was for.",
  share: "How much was spent on each person, whoever paid.",
};

/** The person picker's value for every line at once; user ids are UUIDs, so it never clashes. */
const EVERYONE = "all";

/** Hues in a fixed order; "others" takes the neutral bar colour, never a hue of its own. */
const colorFor = (id: string, index: number) =>
  id === "others" ? "var(--chart-bar)" : `var(--chart-person-${index + 1})`;

export function PeopleSpending({ team }: { team: TeamDetail }) {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const query = usePeopleSpending(team.id);
  const today = todayLocal();
  const [measure, setMeasure] = useState<SpendingMeasure>("share");
  const [period, setPeriod] = useState<SpendingPeriod>("month");
  const [anchor, setAnchor] = useState(today);
  const [person, setPerson] = useState(EVERYONE);

  if (query.isPending) return <div aria-label={t("Loading spending")} aria-busy="true">
    <Card className="p-5"><Skeleton className="mb-6 h-8 w-48" /><Skeleton className="h-56 w-full" /></Card>
  </div>;
  if (query.isError) return <Card><ErrorState message={t("Could not load spending.")} onRetry={() => query.refetch()} /></Card>;

  const { currency, people } = query.data;
  const recorded = people.flatMap((person) => [...person.paid, ...person.share])
    .map((day) => day.date).filter((date) => date <= today).sort();
  if (recorded.length === 0) return null;
  const earliest = recorded[0];

  const start = periodStart(anchor, period);
  const end = shiftPeriod(start, period, 1);
  const previousStart = shiftPeriod(start, period, -1);
  const isCurrent = start === periodStart(today, period);
  const canGoBack = start > periodStart(earliest, period);
  const canGoForward = start < periodStart(today, period);

  const lines = personSeries(people, measure).map((series, i) => ({
    id: series.id,
    name: series.id === "others" ? t("Everyone else") : series.name,
    color: colorFor(series.id, i),
    days: series.days,
    buckets: periodBuckets(series.days, period, anchor, today),
    ...sumSpending(series.days, start, end, today),
    previous: sumSpending(series.days, previousStart, start, today).total,
  }));
  const chosen = lines.find((line) => line.id === person) ?? null;
  const members = new Map(people.map((person) => [person.user_id, person.is_member]));

  const rows = [...lines].sort((a, b) => b.total - a.total);
  const teamTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const teamPrevious = rows.reduce((sum, row) => sum + row.previous, 0);
  // Whole percents that add up to 100, split like money; none once a refund makes a part negative.
  const percents = teamTotal > 0 && rows.every((row) => row.total >= 0)
    ? previewEqualSplit(100, rows.map((row) => row.total)) : null;
  const scale = Math.max(1, ...rows.map((row) => Math.abs(row.total)));
  const columns = lines[0].buckets.filter((bucket) => bucket.total !== null);

  function changePeriod(next: SpendingPeriod) {
    setPeriod(next);
    setAnchor(today);
  }

  return <Card className="p-4 sm:p-5">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-body">{t("By person")}</h3>
        <p className="mt-1 text-[12px] text-muted">{t(EXPLAINED[measure])}</p>
      </div>
      <PeriodPicker value={period} onChange={changePeriod} label={t("Comparison period")} />
    </div>
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <Segmented value={measure} onChange={setMeasure} label={t("What to count")}
        options={SPENDING_MEASURES.map((value) => ({ value, label: t(MEASURES[value]) }))} />
      <Segmented value={chosen?.id ?? EVERYONE} onChange={setPerson} label={t("Whose spending")}
        options={[{ value: EVERYONE, label: t("Everyone") }, ...lines.map((line) => ({
          value: line.id,
          label: <span className="inline-flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ background: line.color }} />{line.name}
          </span>,
        }))]} />
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
      <Money minor={chosen?.total ?? teamTotal} currency={currency} className="text-2xl font-semibold" />
      <SpendingChange current={chosen?.total ?? teamTotal} previous={chosen?.previous ?? teamPrevious} />
      <span className="text-[12px] text-muted">
        {chosen ? t(chosen.expenseCount === 1 ? "{count} expense" : "{count} expenses", { count: chosen.expenseCount }) : t("Team total")}
        {isCurrent && ` · ${t("Through {date}", { date: spendingDate(today, language) })}`}
      </span>
    </div>

    {chosen
      ? <SpendingComparisonChart key={`${chosen.id}-${measure}-${period}-${start}`} current={chosen.buckets}
        previous={periodBuckets(chosen.days, period, previousStart, today)} currency={currency} period={period}
        color={chosen.color} label={t("Spending by person")} />
      : <PeopleSpendingChart key={`${measure}-${period}-${start}`} lines={lines} period={period} currency={currency}
        label={t("Spending by person")} onPick={setPerson} />}

    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-body">{periodLabel(start, end, period, language)}</p>
        <p className="text-[12px] text-muted">{t("Team total")} <Money minor={teamTotal} currency={currency} className="ml-1 font-medium text-body" /></p>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row, i) => {
          const share = percents?.[i] ?? null;
          return <li key={row.id}>
            <button type="button" aria-pressed={chosen?.id === row.id}
              onClick={() => setPerson(chosen?.id === row.id ? EVERYONE : row.id)}
              className={cx("block w-full rounded-control px-2 py-1.5 text-left transition-[opacity,background-color] hover:bg-surface-2",
                chosen && chosen.id !== row.id && "opacity-45 hover:opacity-100")}>
              <span className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2 text-sm text-body">
                  <span className="size-2.5 shrink-0 self-center rounded-full" style={{ background: row.color }} />
                  <span className="truncate">{row.name}</span>
                  {row.id === user?.id && <span className="shrink-0 text-[12px] text-subtle">{t("you")}</span>}
                  {members.get(row.id) === false && <span className="shrink-0 text-[12px] text-subtle">{t("left the team")}</span>}
                </span>
                <span className="shrink-0 text-sm">
                  <Money minor={row.total} currency={currency} />
                  {share !== null && <span className="ml-2 inline-block w-9 text-right text-[12px] text-subtle tabular">{share}%</span>}
                </span>
              </span>
              <span className="track block h-2 w-full rounded-full bg-surface-2">
                {row.total !== 0 && <span className="block h-2 rounded-r-[4px]"
                  style={{ width: `${Math.max(Math.abs(row.total) / scale * 100, 1.5)}%`, background: row.color }} />}
              </span>
            </button>
          </li>;
        })}
      </ul>
    </div>

    <details className="mt-5 border-t border-line pt-3">
      <summary className="cursor-pointer text-[12px] font-medium text-muted hover:text-body">{t("View exact amounts")}</summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <caption className="sr-only">{t("Spending by person")}</caption>
          <thead className="text-muted"><tr>
            <th className="py-2 pr-3 font-medium">{t(period === "year" ? "Month" : "Day")}</th>
            {lines.map((line) => <th key={line.id} className="whitespace-nowrap py-2 pr-3 font-medium">{line.name}</th>)}
            <th className="py-2 font-medium">{t("Team total")}</th>
          </tr></thead>
          <tbody className="divide-y divide-line">{columns.map((bucket, i) => <tr key={bucket.start}>
            <td className="whitespace-nowrap py-2 pr-3">{spendingDate(bucket.start, language, period === "year" ? { day: undefined, month: "short", year: "numeric" } : {})}</td>
            {lines.map((line) => <td key={line.id} className="whitespace-nowrap py-2 pr-3 tabular">{formatMoney(line.buckets[i].total ?? 0, currency)}</td>)}
            <td className="whitespace-nowrap py-2 tabular">{formatMoney(lines.reduce((sum, line) => sum + (line.buckets[i].total ?? 0), 0), currency)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
    <p className="mt-3 text-[11px] text-muted">
      {t("For example, someone buys {total} of groceries for three: under “Who it was for” each of the three has {part}, under “Who paid” the buyer has all {total}.", {
        total: formatMoney(3000 * 10 ** exponentFor(currency), currency),
        part: formatMoney(1000 * 10 ** exponentFor(currency), currency),
      })}
      {" "}{t("Either way, everyone's amounts add up to the team's spending. Refunds are deducted.")}
    </p>
  </Card>;
}
