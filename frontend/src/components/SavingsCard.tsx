import { useState } from "react";
import { Link } from "react-router-dom";
import { useSavings } from "../hooks/queries";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { exponentFor, formatMoney } from "../lib/money";
import {
  periodBuckets, periodStart, shiftPeriod, sumSpending, type SpendingPeriod,
} from "../lib/spending";
import { periodLabel } from "../lib/spending-format";
import type { Savings } from "../lib/types";
import { SpendingComparisonChart } from "./SpendingCharts";
import { PeriodPicker } from "./SpendingTab";
import { Button, Card, Skeleton, cx } from "./ui";

/**
 * What all tracked shopping saved. Saved is the headline because it is the
 * part someone did on purpose -- a sale caught, a cheaper shop chosen -- and
 * what came in over the usual price sits beside it, smaller but never hidden.
 * Full price at the usual shop counts as zero, so nothing is "saved" by
 * comparing with the dearest shop in town.
 *
 * Over time it is the Spending tab's own chart: savings arrive per day in the
 * same shape as spending, so weeks, months and years compare the same way.
 */
export function SavingsCard({ teamId }: { teamId: string }) {
  const savings = useSavings(teamId);

  if (savings.isPending) {
    return <Card className="p-4 sm:p-5"><Skeleton className="mb-3 h-4 w-40" /><Skeleton className="h-10 w-48" /></Card>;
  }
  if (!savings.data || savings.data.purchases === 0) return null;
  return <SavingsBody data={savings.data} teamId={teamId} />;
}

function SavingsBody({ data, teamId }: { data: Savings; teamId: string }) {
  const { t, language } = useI18n();
  const { currency, days } = data;
  const today = todayLocal();
  const [period, setPeriod] = useState<SpendingPeriod>("month");
  const [anchor, setAnchor] = useState(today);
  const net = data.saved - data.extra;
  const nothingYet = data.saved === 0 && data.extra === 0;
  // Rounding leaves kopecks of "saving" on some goods; a best buy is worth a rouble.
  const best = data.best.filter((item) => item.saved >= 10 ** exponentFor(currency));

  const start = periodStart(anchor, period);
  const end = shiftPeriod(start, period, 1);
  const previousStart = shiftPeriod(start, period, -1);
  const current = sumSpending(days, start, end, today).total;
  const isCurrent = start === periodStart(today, period);
  const earliest = days[0]?.date ?? today;

  return (
    <Card className="p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-body">{t("What your shopping saved")}</h3>
      <p className="mt-1 text-[12px] text-muted">{t("Each purchase against that item's usual price when you bought it.")}</p>

      {nothingYet ? (
        <p className="mt-4 text-sm text-muted">
          {t("Nothing yet. Savings show up when you buy on sale, or in a shop cheaper than the others you know.")}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-[12px] font-medium text-muted">{t("Saved")}</p>
              <p className="text-3xl font-semibold tracking-tight text-body">{formatMoney(data.saved, currency)}</p>
            </div>
            {data.on_sale > 0 && (
              <div>
                <p className="text-[12px] font-medium text-muted">{t("of it on sales")}</p>
                <p className="text-lg font-medium text-body">{formatMoney(data.on_sale, currency)}</p>
              </div>
            )}
            <div>
              <p className="text-[12px] font-medium text-muted">{t("Paid over usual")}</p>
              <p className="text-lg font-medium text-body">{formatMoney(data.extra, currency)}</p>
            </div>
          </div>
          <p className="mt-2">
            <span className={cx(
              "inline-flex rounded-full px-2 py-1 text-[12px] font-medium",
              net > 0 ? "bg-price-low-soft text-price-low" : "bg-surface-2 text-muted",
            )}>
              {net >= 0
                ? t("Overall {amount} under usual prices", { amount: formatMoney(net, currency) })
                : t("Overall {amount} over usual prices", { amount: formatMoney(-net, currency) })}
            </span>
          </p>

          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-body">{periodLabel(start, end, period, language)}</p>
                <p className="mt-1 text-[12px] text-muted">
                  {t("Net saved {amount} · compared with {period}", {
                    amount: formatMoney(current, currency),
                    period: periodLabel(previousStart, start, period, language),
                  })}
                </p>
              </div>
              <PeriodPicker value={period} onChange={(next) => { setPeriod(next); setAnchor(today); }} label={t("Comparison period")} />
            </div>
            <div className="mb-3 flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={start <= periodStart(earliest, period)} aria-label={t("Previous period")}
                onClick={() => setAnchor(previousStart)}>←</Button>
              <Button variant="secondary" size="sm" disabled={isCurrent} onClick={() => setAnchor(today)}>{t("Current period")}</Button>
              <Button variant="ghost" size="sm" disabled={isCurrent} aria-label={t("Next period")}
                onClick={() => setAnchor(end)}>→</Button>
            </div>
            <SpendingComparisonChart
              key={`${period}-${start}`}
              current={periodBuckets(days, period, anchor, today)}
              previous={periodBuckets(days, period, previousStart, today)}
              currency={currency}
              period={period}
              label={t("Savings comparison chart")}
            />
          </div>

          {best.length > 0 && (
            <div className="mt-5 border-t border-line pt-3">
              <p className="mb-1 text-[12px] font-medium text-muted">{t("Best buys")}</p>
              <ul className="divide-y divide-line">
                {best.map((item) => (
                  <li key={item.product_id}>
                    <Link to={`/teams/${teamId}/goods/${item.product_id}`}
                      className="flex items-baseline justify-between gap-3 py-2 text-[13px] hover:text-body">
                      <span className="min-w-0 truncate text-body">{item.name}</span>
                      <span className="shrink-0 tabular text-price-low">+{formatMoney(item.saved, currency)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-[11px] text-muted">
        {t("{compared} of {purchases} purchases had a usual price to compare with. Full price at the shop you always use counts as zero.", {
          compared: data.compared, purchases: data.purchases,
        })}
      </p>
    </Card>
  );
}
