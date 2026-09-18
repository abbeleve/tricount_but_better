/**
 * The two visualisations in the app.
 *
 * Both follow the same discipline: one measure per chart, thin marks, recessive
 * axes, direct labels rather than a number on every hover, and colour that is
 * never the only carrier of meaning.
 */

import { Money, cx } from "./ui";
import type { Balance, CategoryTotal } from "../lib/types";
import { formatMoney } from "../lib/money";

/* ---------------------------------------------------------- balance meter */

/**
 * Diverging bars around a centre line.
 *
 * Direction is encoded by POSITION first -- left of centre means "owes", right
 * means "is owed" -- so the teal/orange pair is reinforcement, not the sole
 * signal. Every row is directly labelled, so there is no hover-only data.
 */
export function BalanceMeter({
  balances,
  currency,
  currentUserId,
}: {
  balances: Balance[];
  currency: string;
  currentUserId: string;
}) {
  const scale = Math.max(1, ...balances.map((b) => Math.abs(b.net)));
  const ordered = [...balances].sort((a, b) => b.net - a.net);

  return (
    <div>
      {/* The axis legend: says what each side of the centre line means. */}
      <div className="mb-3 flex items-center justify-between text-[11px] text-subtle">
        <span>owes</span>
        <span>settled</span>
        <span>is owed</span>
      </div>

      <ul className="flex flex-col gap-3.5">
        {ordered.map((balance) => {
          const fraction = Math.abs(balance.net) / scale;
          const owed = balance.net > 0;
          const isMe = balance.user_id === currentUserId;

          return (
            <li key={balance.user_id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="truncate text-sm text-body">
                  {balance.display_name}
                  {isMe && <span className="ml-1.5 text-[12px] text-subtle">you</span>}
                </span>
                <Money minor={balance.net} currency={currency} signed className="text-sm" />
              </div>

              {/* Track with a centre baseline; the bar grows away from it. */}
              <div className="relative h-2 w-full rounded-full bg-surface-2">
                <div className="absolute inset-y-[-3px] left-1/2 w-px -translate-x-1/2 bg-line-strong" />
                {balance.net !== 0 && (
                  <div
                    className={cx(
                      "absolute top-0 h-2",
                      owed
                        ? "left-1/2 rounded-r-[4px] bg-positive-mark"
                        : "right-1/2 rounded-l-[4px] bg-negative-mark",
                    )}
                    style={{ width: `${Math.max(fraction * 50, 1.5)}%` }}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------ category breakdown */

/**
 * One measure across categories, so a single neutral bar colour is correct --
 * hue would imply a distinction the data does not have. Identity comes from the
 * row label. The hover tooltip adds the share of total, which is not shown
 * directly anywhere.
 */
export function CategoryBreakdown({
  totals,
  currency,
}: {
  totals: CategoryTotal[];
  currency: string;
}) {
  const grand = totals.reduce((sum, t) => sum + t.total, 0);
  const scale = Math.max(1, ...totals.map((t) => t.total));

  return (
    <ul className="flex flex-col gap-3">
      {totals.map((entry) => {
        const share = grand > 0 ? Math.round((entry.total / grand) * 100) : 0;
        return (
          <li
            key={entry.category_id ?? "none"}
            className="group"
            title={`${entry.name}: ${formatMoney(entry.total, currency)} — ${share}% of all spending`}
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="truncate text-sm text-body">
                {entry.emoji && <span className="mr-1.5">{entry.emoji}</span>}
                {entry.name}
              </span>
              <span className="shrink-0 text-sm text-muted">
                <Money minor={entry.total} currency={currency} />
                <span className="ml-2 text-[12px] text-subtle tabular">{share}%</span>
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-surface-2">
              <div
                className="h-2 rounded-r-[4px] bg-chart-bar opacity-80 transition-opacity group-hover:opacity-100"
                style={{ width: `${Math.max((entry.total / scale) * 100, 1.5)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
