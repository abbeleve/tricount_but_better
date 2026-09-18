import { Link, useParams, useSearchParams } from "react-router-dom";
import { AppShell, BackLink, PageTitle } from "../components/Layout";
import { BalancesTab } from "../components/BalancesTab";
import { ExpensesTab } from "../components/ExpensesTab";
import { PeopleTab } from "../components/PeopleTab";
import { Card, ErrorState, Skeleton, cx } from "../components/ui";
import { useTeam } from "../hooks/queries";
import { ApiError } from "../lib/api";

const TABS = [
  { id: "balances", label: "Balances" },
  { id: "expenses", label: "Expenses" },
  { id: "people", label: "People" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function TeamDetailPage() {
  const { teamId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const team = useTeam(teamId);

  const active = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "balances") as TabId;

  if (team.isPending) {
    return (
      <AppShell>
        <Skeleton className="mb-6 h-9 w-56" />
        <Card className="h-64" />
      </AppShell>
    );
  }

  if (team.isError || !team.data) {
    return (
      <AppShell>
        <BackLink to="/">All teams</BackLink>
        <Card>
          <ErrorState
            message={
              team.error instanceof ApiError && team.error.status === 404
                ? "This team does not exist, or you are not a member of it."
                : "Could not load this team."
            }
            onRetry={() => team.refetch()}
          />
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <BackLink to="/">All teams</BackLink>
      <PageTitle
        title={team.data.name}
        subtitle={`${team.data.members.length} people · ${team.data.currency}`}
        action={
          <Link
            to={`/teams/${teamId}/expenses/new`}
            className={cx(
              "hidden h-10 items-center rounded-control bg-ink px-4 text-sm font-medium",
              "text-ink-text transition-all hover:bg-ink-hover active:translate-y-px sm:inline-flex",
            )}
          >
            Add expense
          </Link>
        }
      />

      {/* Tabs scroll horizontally rather than wrapping on a narrow phone. */}
      <div
        role="tablist"
        aria-label="Team sections"
        className="no-scrollbar mb-5 -mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => setParams(tab.id === "balances" ? {} : { tab: tab.id })}
            className={cx(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
              active === tab.id
                ? "border-ink font-medium text-body"
                : "border-transparent text-muted hover:text-body",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "balances" && <BalancesTab team={team.data} />}
      {active === "expenses" && <ExpensesTab team={team.data} />}
      {active === "people" && <PeopleTab team={team.data} />}

      {/* Phone: the primary action stays reachable with a thumb. */}
      <Link
        to={`/teams/${teamId}/expenses/new`}
        className={cx(
          "fixed bottom-5 right-5 z-30 flex h-13 items-center gap-2 rounded-full px-5 sm:hidden",
          "bg-ink text-sm font-medium text-ink-text shadow-lg transition-transform active:translate-y-px",
        )}
        style={{ height: 52, bottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add expense
      </Link>
    </AppShell>
  );
}
