import { useState } from "react";
import { usePeopleSpending } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { exponentFor, formatMoney, previewEqualSplit } from "../lib/money";
import {
  SPENDING_MEASURES, historyBuckets, historyLength, periodStart, personSeries, shiftPeriod,
  type SpendingMeasure, type SpendingPeriod,
} from "../lib/spending";
import { periodLabel } from "../lib/spending-format";
import type { TeamDetail } from "../lib/types";
import { PeriodPicker, Segmented } from "./Segmented";
import { PeopleSpendingChart, type PersonLine } from "./SpendingCharts";
import { Button, Card, ErrorState, Money, Skeleton } from "./ui";

const MEASURES = { paid: "Who paid", share: "Who it was for" };
const EXPLAINED = {
  paid: "How much each person paid themselves, whoever it was for.",
  share: "How much was spent on each person, whoever paid.",
};

const earlierOf = (a: string, b: string) => a < b ? a : b;

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
  const [end, setEnd] = useState(today);
  const [picked, setPicked] = useState<string | null>(null);

  if (query.isPending) return <div aria-label={t("Loading spending")} aria-busy="true">
    <Card className="p-5"><Skeleton className="mb-6 h-8 w-48" /><Skeleton className="h-56 w-full" /></Card>
  </div>;
  if (query.isError) return <Card><ErrorState message={t("Could not load spending.")} onRetry={() => query.refetch()} /></Card>;

  const { currency, people } = query.data;
  const recorded = people.flatMap((person) => [...person.paid, ...person.share])
    .map((day) => day.date).filter((date) => date <= today).sort();
  if (recorded.length === 0) return null;
  const earliest = recorded[0];

  const count = historyLength(earliest, end, period);
  const lines: PersonLine[] = personSeries(people, measure).map((series, i) => ({
    id: series.id,
    name: series.id === "others" ? t("Everyone else") : series.name,
    color: colorFor(series.id, i),
    buckets: historyBuckets(series.days, period, end, today, count),
  }));
  const columns = lines[0].buckets;
  const found = columns.findIndex((bucket) => bucket.start === picked);
  const selected = found === -1 ? columns.length - 1 : found;
  const column = columns[selected];
  const members = new Map(people.map((person) => [person.user_id, person.is_member]));

  const rows = lines.map((line) => ({ ...line, total: line.buckets[selected].total ?? 0 }))
    .sort((a, b) => b.total - a.total);
  const teamTotal = rows.reduce((sum, row) => sum + row.total, 0);
  // Whole percents that add up to 100, split like money; none once a refund makes a part negative.
  const percents = teamTotal > 0 && rows.every((row) => row.total >= 0)
    ? previewEqualSplit(100, rows.map((row) => row.total)) : null;
  const scale = Math.max(1, ...rows.map((row) => Math.abs(row.total)));

  function changePeriod(next: SpendingPeriod) {
    setPeriod(next);
    setEnd(today);
    setPicked(null);
  }

  return <Card className="p-4 sm:p-5">
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-body">{t("By person")}</h3>
      <p className="mt-1 text-[12px] text-muted">{t(EXPLAINED[measure])}</p>
    </div>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Segmented value={measure} onChange={setMeasure} label={t("What to count")}
        options={SPENDING_MEASURES.map((value) => ({ value, label: t(MEASURES[value]) }))} />
      <PeriodPicker value={period} onChange={changePeriod} label={t("History grouping")} />
    </div>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-[12px] text-muted">{periodLabel(columns[0].start, columns[0].end, period, language)} – {periodLabel(columns[count - 1].start, columns[count - 1].end, period, language)}</p>
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" disabled={columns[0].start <= periodStart(earliest, period)} aria-label={t("Older periods")}
          onClick={() => { setEnd(shiftPeriod(end, period, -12)); setPicked(null); }}>←</Button>
        <Button variant="ghost" size="sm" disabled={periodStart(end, period) >= periodStart(today, period)} aria-label={t("Newer periods")}
          onClick={() => { setEnd(earlierOf(shiftPeriod(end, period, 12), today)); setPicked(null); }}>→</Button>
      </div>
    </div>

    <PeopleSpendingChart lines={lines} period={period} currency={currency} selected={selected}
      onSelect={(i) => setPicked(columns[i].start)} label={t("Spending by person")} />

    <div className="mt-4 border-t border-line pt-4" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-body">{periodLabel(column.start, column.end, period, language)}</p>
        <p className="text-[12px] text-muted">{t("Team total")} <Money minor={teamTotal} currency={currency} className="ml-1 font-medium text-body" /></p>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row, i) => {
          const share = percents?.[i] ?? null;
          return <li key={row.id}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
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
            </div>
            <div className="track h-2 w-full rounded-full bg-surface-2">
              {row.total !== 0 && <div className="h-2 rounded-r-[4px]"
                style={{ width: `${Math.max(Math.abs(row.total) / scale * 100, 1.5)}%`, background: row.color }} />}
            </div>
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
            <th className="py-2 pr-3 font-medium">{t("Period")}</th>
            {lines.map((line) => <th key={line.id} className="whitespace-nowrap py-2 pr-3 font-medium">{line.name}</th>)}
            <th className="py-2 font-medium">{t("Team total")}</th>
          </tr></thead>
          <tbody className="divide-y divide-line">{[...columns.keys()].reverse().map((i) => <tr key={columns[i].start}>
            <td className="whitespace-nowrap py-2 pr-3">{periodLabel(columns[i].start, columns[i].end, period, language)}</td>
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
