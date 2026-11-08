import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { BalancesTab } from "../components/BalancesTab";
import { SpendingTab } from "../components/SpendingTab";
import { ExpensesTab } from "../components/ExpensesTab";
import { PeopleTab } from "../components/PeopleTab";
import { CategoriesTab } from "../components/CategoriesTab";
import { Card, ErrorState, PRESS, Skeleton, cx } from "../components/ui";
import { usePersonalTeam, useTeam } from "../hooks/queries";
import { expensesPath } from "../lib/personal";
import { ApiError } from "../lib/api";
import { personWord, useI18n } from "../lib/i18n";
import { lazyPage } from "../lib/lazyPage";

const PricesTab = lazyPage(() => import("../components/PricesTab").then((m) => ({ default: m.PricesTab })));

const TABS = [
  { id: "balances", label: "Balances" },
  { id: "expenses", label: "Expenses" },
  { id: "spending", label: "Spending" },
  { id: "prices", label: "Prices" },
  { id: "people", label: "People" },
  { id: "categories", label: "Categories" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const BACK = { to: "/", label: "All teams" };

/**
 * One indicator that slides between tabs, so switching reads as moving along
 * the strip rather than one underline vanishing and another appearing. It is
 * measured from the live buttons, so it holds at any width and any label length.
 */
function Tabs({ active, onSelect, personal = false }: { active: TabId; onSelect: (id: TabId) => void; personal?: boolean }) {
  const { t } = useI18n();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[active];
      if (el) setBar({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    Object.values(refs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      className={cx(
        // Sticks under the header so the sections stay one tap away down a long list.
        "material bleed sticky top-[calc(var(--header-h)+env(safe-area-inset-top))] z-30 mb-5",
        "border-b border-line",
      )}
    >
      <div role="tablist" aria-label={t("Team sections")} className="no-scrollbar relative flex max-w-full overflow-x-auto overflow-y-hidden sm:gap-1">
        {TABS.filter((tab) => !personal || (tab.id !== "people" && tab.id !== "balances")).map((tab) => (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => onSelect(tab.id)}
            className={cx(
              "h-11 shrink-0 flex-1 whitespace-nowrap px-2 text-sm transition-colors sm:flex-none sm:px-3",
              "active:opacity-60 active:duration-0",
              active === tab.id ? "font-medium text-body" : "text-muted hover:text-body",
            )}
          >
            {t(tab.label)}
          </button>
        ))}
        {bar && (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 rounded-full bg-indicator transition-[transform,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
            style={{ width: bar.w, transform: `translateX(${bar.x}px)` }}
          />
        )}
      </div>
    </div>
  );
}

export default function TeamDetailPage() {
  const { t, language } = useI18n();
  const { teamId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const team = useTeam(teamId);

  const active = (TABS.find((t) => t.id === params.get("tab"))?.id ?? (team.data?.is_personal ? "expenses" : "balances")) as TabId;
  const personal = active === "expenses" && params.get("scope") === "personal";
  const personalTeam = usePersonalTeam(teamId, personal && team.data?.is_personal === false);

  if (team.isPending) {
    return (
      <AppShell back={{ ...BACK, label: t(BACK.label) }}>
        <Skeleton className="mb-6 h-9 w-56" />
        <Card className="h-64" />
      </AppShell>
    );
  }

  if (team.isError || !team.data) {
    return (
      <AppShell back={{ ...BACK, label: t(BACK.label) }}>
        <Card>
          <ErrorState
            message={
              team.error instanceof ApiError && team.error.status === 404
                ? t("This team does not exist, or you are not a member of it.")
                : t("Could not load this team.")
            }
            onRetry={() => team.refetch()}
          />
        </Card>
      </AppShell>
    );
  }

  if (team.data.is_personal && ["expenses", "balances", "people"].includes(active)) {
    return <Navigate to={expensesPath(team.data)} replace />;
  }

  if (team.data.parent_team_id && active === "spending") {
    return <Navigate to={`/teams/${team.data.parent_team_id}?tab=spending`} replace />;
  }

  const expenseTeam = personal ? personalTeam.data : team.data;
  const addPath = expenseTeam ? `/teams/${expenseTeam.id}/expenses/new` : null;
  const addLabel = t(personal || team.data.is_personal ? "Add personal expense" : "Add expense");
  const back = team.data.is_personal
    ? { to: expensesPath(team.data), label: t("Personal expenses") }
    : { ...BACK, label: t(BACK.label) };

  return (
    <AppShell back={back}>
      <PageTitle
        title={team.data.is_personal ? t("Personal expenses") : team.data.name}
        subtitle={team.data.is_personal ? `${team.data.name} · ${team.data.currency}` : `${team.data.members.length} ${personWord(team.data.members.length, language)} · ${team.data.currency}`}
        action={
          addPath && <Link
            to={addPath}
            className={cx(
              "hidden h-10 items-center rounded-button bg-ink px-4 text-sm font-medium",
              "text-ink-text hover:bg-ink-hover sm:inline-flex",
              PRESS,
            )}
          >
            {addLabel}
          </Link>
        }
      />

      <Tabs
        active={active}
        personal={team.data.is_personal}
        onSelect={(id) => setParams(id === "balances" ? {} : { tab: id }, { replace: true })}
      />

      {active === "balances" && <BalancesTab team={team.data} />}
      {active === "expenses" && (
        <div className="flex flex-col gap-4">
          <div role="group" aria-label={t("Expense type")} className="grid grid-cols-2 rounded-segment bg-surface-2 p-1">
            {(["shared", "personal"] as const).map((scope) => (
              <button key={scope} type="button" aria-pressed={personal === (scope === "personal")}
                onClick={() => setParams({ tab: "expenses", ...(scope === "personal" ? { scope } : {}) }, { replace: true })}
                className={cx("min-h-11 rounded-segment-option px-2 py-2 text-sm transition-colors",
                  personal === (scope === "personal") ? "bg-raised font-medium text-body shadow-raised" : "text-muted hover:text-body")}>
                {t(scope === "personal" ? "Personal expenses" : "Shared expenses")}
              </button>
            ))}
          </div>
          {personal && <p className="px-1 text-[13px] text-muted">{t("Only you can see these expenses. No notifications are sent, and team balances stay unchanged.")}</p>}
          {personal && personalTeam.isPending && <Card className="p-5"><Skeleton className="h-48 w-full" /></Card>}
          {personal && personalTeam.isError && <Card><ErrorState message={t("Could not load personal expenses.")} onRetry={() => personalTeam.refetch()} /></Card>}
          {expenseTeam && <ExpensesTab key={expenseTeam.id} team={expenseTeam} />}
        </div>
      )}
      {active === "spending" && <SpendingTab team={team.data} />}
      {active === "prices" && (
        <Suspense fallback={<Card className="p-5"><Skeleton className="h-48 w-full" /></Card>}>
          <PricesTab team={team.data} />
        </Suspense>
      )}
      {active === "people" && <PeopleTab team={team.data} />}
      {active === "categories" && <CategoriesTab teamId={teamId} />}

      {/* Phone: the primary action stays reachable with a thumb, above the home indicator. */}
      {addPath && <Link
        to={addPath}
        className={cx(
          "fixed z-30 flex h-13 items-center gap-2 rounded-full px-5 sm:hidden",
          "bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))]",
          "bg-ink text-[15px] font-medium text-ink-text shadow-lg shadow-black/20",
          PRESS,
        )}
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {addLabel}
      </Link>}
    </AppShell>
  );
}
