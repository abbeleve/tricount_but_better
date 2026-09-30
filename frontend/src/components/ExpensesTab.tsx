import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Chip, EmptyState, ErrorState, Input, Money, ROW_PRESS, Skeleton, cx } from "./ui";
import { useCategories, useExpenses, usePlans } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import type { Expense, TeamDetail } from "../lib/types";

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Groups by day so a busy week reads as a timeline rather than a flat list. */
function groupByDate(expenses: Expense[]): [string, Expense[]][] {
  const groups = new Map<string, Expense[]>();
  for (const expense of expenses) {
    const bucket = groups.get(expense.spent_at) ?? [];
    bucket.push(expense);
    groups.set(expense.spent_at, bucket);
  }
  return [...groups.entries()];
}

export function ExpensesTab({ team }: { team: TeamDetail }) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const expenses = useExpenses(team.id, search);
  const plans = usePlans(team.id);
  const categories = useCategories(team.id);

  const nameOf = (id: string) =>
    team.members.find((m) => m.user_id === id)?.display_name ?? "Someone";
  const emojiOf = (id: string | null) =>
    id ? (categories.data?.find((c) => c.id === id)?.emoji ?? "") : "";

  const rows = expenses.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div>
            <h3 className="text-sm font-medium text-body">Upcoming purchases</h3>
            <p className="text-[12px] text-muted">Shopping lists stay out of balances until purchased.</p>
          </div>
          <Link to={`/teams/${team.id}/plans/new`}
            className="shrink-0 rounded-control border border-line-strong px-3 py-2 text-[13px] font-medium text-body hover:bg-surface-2">
            New plan
          </Link>
        </div>
        {plans.isPending && <Card className="h-18 p-4"><Skeleton className="h-4 w-40" /></Card>}
        {plans.isError && <Card><ErrorState message="Could not load plans." onRetry={() => plans.refetch()} /></Card>}
        {plans.data && plans.data.length === 0 && (
          <Card className="px-4 py-5 text-sm text-muted">Nothing planned yet. Add a shopping list when you know what to buy.</Card>
        )}
        {plans.data && plans.data.length > 0 && (
          <Card className="divide-y divide-line overflow-hidden">
            {plans.data.map((plan) => (
              <Link key={plan.id} to={`/teams/${team.id}/plans/${plan.id}`}
                className={cx("block px-4 py-3.5 hover:bg-surface-2", ROW_PRESS)}>
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium text-body">{plan.title}</span>
                  <Chip>planned</Chip>
                </div>
                <p className="mt-1 truncate text-[13px] text-muted">
                  {plan.items.map((item) => item.name).join(" · ")}
                </p>
              </Link>
            ))}
          </Card>
        )}
      </section>
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search expenses"
        aria-label="Search expenses"
        enterKeyHint="search"
        // Results filter as you type, so the return key only needs to put the keyboard away.
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />

      {expenses.isPending && (
        <Card className="divide-y divide-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4 p-4">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </Card>
      )}

      {expenses.data && rows.length === 0 && (
        <Card>
          <EmptyState
            title={search ? "Nothing matched" : "No expenses yet"}
            body={
              search
                ? "Try a different word, or clear the search."
                : "Add the first one. You can type a total and split it, or photograph a receipt and split it line by line."
            }
          />
        </Card>
      )}

      {rows.length > 0 &&
        groupByDate(rows).map(([date, group]) => (
          <section key={date}>
            <h3 className="mb-2 px-1 text-[12px] font-medium text-subtle">{formatDate(date)}</h3>
            <Card className="divide-y divide-line overflow-hidden">
              {group.map((expense) => {
                const myShare = expense.shares.find((s) => s.user_id === user?.id)?.amount ?? 0;
                const iPaid = expense.payer_id === user?.id;
                const emoji = emojiOf(expense.category_id);
                return (
                  /* Two independent lines rather than two columns: the title
                     only competes with the total for width, not with the
                     longer "your share" line, so it truncates far later on a phone. */
                  <Link
                    key={expense.id}
                    to={`/teams/${team.id}/expenses/${expense.id}`}
                    className={cx("block select-none px-4 py-3.5 hover:bg-surface-2", ROW_PRESS)}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate font-medium text-body">
                        {emoji && <span className="mr-1.5">{emoji}</span>}
                        {expense.title}
                      </p>
                      <Money
                        minor={expense.total}
                        currency={expense.currency}
                        className="shrink-0 font-medium"
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                        <span className="truncate">
                          {iPaid ? "You paid" : `${nameOf(expense.payer_id)} paid`}
                        </span>
                        {expense.split_mode === "items" && (
                          <Chip>{expense.items.length} items</Chip>
                        )}
                        {expense.source === "receipt" && <Chip>scanned</Chip>}
                      </p>
                      <p className="shrink-0 text-right text-[12px] text-muted">
                        {myShare === 0 ? (
                          "you are not on this one"
                        ) : (
                          <>
                            your share{" "}
                            <Money minor={myShare} currency={expense.currency} className="text-[12px]" />
                          </>
                        )}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </Card>
          </section>
        ))}
    </div>
  );
}
