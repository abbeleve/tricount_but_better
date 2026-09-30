import { useEffect, useState } from "react";
import { BalanceMeter, CategoryBreakdown } from "./charts";
import { Button, Card, EmptyState, Money, Skeleton } from "./ui";
import {
  useBalances,
  useCategoryTotals,
  useDeleteSettlement,
  useSettleUp,
} from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { todayLocal } from "../lib/dates";
import { formatMoney } from "../lib/money";
import type { Settlement, TeamDetail } from "../lib/types";

/** How long "Undo" stays offered after marking a payment made. */
const UNDO_MS = 8000;

export function BalancesTab({ team }: { team: TeamDetail }) {
  const { user } = useAuth();
  const balances = useBalances(team.id);
  const totals = useCategoryTotals(team.id);
  const settle = useSettleUp(team.id);
  const unsettle = useDeleteSettlement(team.id);
  const [settling, setSettling] = useState<string | null>(null);
  const [justSettled, setJustSettled] = useState<Settlement | null>(null);

  useEffect(() => {
    if (!justSettled) return;
    const timer = setTimeout(() => setJustSettled(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [justSettled]);

  const nameOf = (id: string) =>
    team.members.find((m) => m.user_id === id)?.display_name ?? "Someone";
  const subjectOf = (id: string) => (id === user?.id ? "You" : nameOf(id));

  if (balances.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full max-w-48" />
              <Skeleton className="h-2 w-full" />
            </div>
          ))}
        </Card>
      </div>
    );
  }

  if (!balances.data) return null;

  const { transfers, total_spend, currency } = balances.data;
  const everyoneSettled = balances.data.balances.every((b) => b.net === 0);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        {/* Stacks on a phone: side by side, both halves wrap to two lines. */}
        <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <h2 className="text-sm font-semibold text-body">Where everyone stands</h2>
          <span className="text-[13px] text-muted">
            {formatMoney(total_spend, currency)} spent in total
          </span>
        </div>
        <BalanceMeter
          balances={balances.data.balances}
          currency={currency}
          currentUserId={user?.id ?? ""}
        />
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="mb-1 text-sm font-semibold text-body">Settle up</h2>
        <p className="mb-4 text-[13px] text-muted">
          {everyoneSettled
            ? "Nothing outstanding."
            : `${transfers.length} ${transfers.length === 1 ? "payment clears" : "payments clear"} every debt in this team.`}
        </p>

        {justSettled && (
          <div
            role="status"
            className="mb-3 flex items-center justify-between gap-3 rounded-control bg-surface-2 py-1.5 pl-3 pr-1.5"
          >
            <p className="min-w-0 text-[13px] text-body">
              {subjectOf(justSettled.from_user_id)} paid {nameOf(justSettled.to_user_id)}{" "}
              <Money minor={justSettled.amount} currency={currency} className="text-[13px]" />
            </p>
            <Button
              size="sm"
              variant="ghost"
              loading={unsettle.isPending}
              onClick={() =>
                unsettle.mutate(justSettled.id, { onSuccess: () => setJustSettled(null) })
              }
            >
              Undo
            </Button>
          </div>
        )}

        {everyoneSettled ? (
          <p className="py-2 text-sm text-muted">Everyone is square. Nice.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {transfers.map((transfer) => {
              const key = `${transfer.from_user_id}-${transfer.to_user_id}`;
              const mine = transfer.from_user_id === user?.id;
              return (
                <li key={key} className="flex items-center gap-3 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-body">
                      <span className="font-medium">{subjectOf(transfer.from_user_id)}</span>
                      <span className="text-muted"> {mine ? "pay" : "pays"} </span>
                      <span className="font-medium">{nameOf(transfer.to_user_id)}</span>
                    </p>
                    <Money
                      minor={transfer.amount}
                      currency={currency}
                      className="mt-0.5 block text-[15px] font-medium"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    loading={settle.isPending && settling === key}
                    onClick={() => {
                      setSettling(key);
                      settle.mutate(
                        {
                          from_user_id: transfer.from_user_id,
                          to_user_id: transfer.to_user_id,
                          amount: transfer.amount,
                          settled_at: todayLocal(),
                          note: "Settled up",
                        },
                        { onSuccess: setJustSettled },
                      );
                    }}
                  >
                    Mark paid
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="mb-4 text-sm font-semibold text-body">Spending by category</h2>
        {totals.isPending && (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full max-w-40" />
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        )}
        {totals.data?.length === 0 && (
          <EmptyState title="Nothing spent yet" body="Add an expense and the breakdown appears here." />
        )}
        {totals.data && totals.data.length > 0 && (
          <CategoryBreakdown totals={totals.data} currency={currency} />
        )}
      </Card>
    </div>
  );
}
