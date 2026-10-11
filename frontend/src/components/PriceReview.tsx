import { useI18n } from "../lib/i18n";
import { formatMoney } from "../lib/money";
import { formatPercent, shortDate } from "../lib/price-format";
import { priceGap } from "../lib/prices";
import type { PriceAnswer, PriceDecision } from "../lib/types";
import { Input, cx } from "./ui";

const DECISIONS: { id: PriceDecision; label: string; hint: string }[] = [
  { id: "regular", label: "New price", hint: "The shop's price is now this." },
  { id: "sale", label: "On sale", hint: "Temporary. The usual price comes back when the sale ends." },
  { id: "keep", label: "Keep old", hint: "A one-off or a misread. Nothing changes." },
];

/**
 * One question per good whose receipt price differs from the shop's saved one.
 * A sale is the reason this is a question at all: it is a real price, but a
 * temporary one, so it is kept beside the regular price with an end date
 * instead of replacing it.
 */
export function PriceReview({
  answers,
  onChange,
  currency,
}: {
  answers: PriceAnswer[];
  onChange: (answers: PriceAnswer[]) => void;
  currency: string;
}) {
  const { t, language } = useI18n();
  const update = (index: number, patch: Partial<PriceAnswer>) =>
    onChange(answers.map((answer, i) => (i === index ? { ...answer, ...patch } : answer)));

  return (
    <ul className="flex flex-col divide-y divide-line">
      {answers.map((answer, index) => {
        const { change } = answer;
        const gap = change.saved_price ? priceGap(change.price, change.saved_price) : null;
        return (
          <li key={`${change.product_id}-${change.shop_id}`} className="flex flex-col gap-3 py-4 first:pt-1 last:pb-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-body">{change.product_name}</p>
                <p className="text-[12px] text-muted">
                  {change.shop_name} · {shortDate(change.observed_on, language, true)}
                  {change.on_sale && <span className="ml-1.5 text-price-low">{t("marked as discounted")}</span>}
                </p>
              </div>
              <p className="flex shrink-0 items-baseline gap-2 text-sm">
                {change.saved_price !== null && (
                  <span className="tabular text-muted line-through decoration-1">
                    {formatMoney(change.saved_price, currency)}
                  </span>
                )}
                <span aria-hidden="true" className="text-subtle">→</span>
                <span className="tabular font-medium text-body">{formatMoney(change.price, currency)}</span>
                {gap && gap.percent !== null && (
                  <span className={cx(
                    "rounded-full px-1.5 py-px text-[11px] font-medium",
                    gap.diff > 0 ? "bg-price-high-soft text-price-high" : "bg-price-low-soft text-price-low",
                  )}>
                    {gap.diff > 0 ? "↑" : "↓"} {formatPercent(gap.percent, language)}%
                  </span>
                )}
              </p>
            </div>
            {change.saved_on_sale && (
              <p className="-mt-1 text-[12px] text-muted">{t("The saved price was a sale price.")}</p>
            )}
            {change.regular_price !== null && (
              <p className="-mt-1 text-[12px] text-muted">
                {t("The receipt shows the usual price as {price}.", { price: formatMoney(change.regular_price, currency) })}
              </p>
            )}
            <div role="radiogroup" aria-label={t("What is this price?")} className="grid grid-cols-3 gap-1 rounded-segment bg-surface-2 p-1">
              {DECISIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={answer.decision === option.id}
                  onClick={() => update(index, { decision: option.id })}
                  className={cx(
                    "rounded-segment-option px-2 py-2 text-[13px] transition-colors",
                    answer.decision === option.id ? "bg-raised font-medium text-body shadow-raised" : "text-muted hover:text-body",
                  )}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
            <p className="-mt-1 text-[12px] text-muted">
              {t(DECISIONS.find((option) => option.id === answer.decision)!.hint)}
            </p>
            {answer.decision === "sale" && (
              <label className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-body">
                <span>{t("Sale ends")}</span>
                <Input
                  type="date"
                  className="w-auto"
                  min={change.observed_on}
                  value={answer.saleUntil ?? ""}
                  onChange={(event) => update(index, { saleUntil: event.target.value })}
                />
                <span className="text-[12px] text-muted">{t("A guess is fine; a week if you are not sure.")}</span>
              </label>
            )}
          </li>
        );
      })}
    </ul>
  );
}
