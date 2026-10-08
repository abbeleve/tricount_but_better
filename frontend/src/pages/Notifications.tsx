import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { Avatar, Card, EmptyState, ErrorState, FormError, Money, ROW_PRESS, Skeleton, Switch, cx } from "../components/ui";
import { useMarkNotificationsRead, useNotifications, useServerConfig } from "../hooks/queries";
import { ApiError } from "../lib/api";
import { relativeTime } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { formatMoney } from "../lib/money";
import { currentPushState, disablePush, enablePush, type PushState } from "../lib/push";
import type { AppNotification } from "../lib/types";

const PUSH_HINT: Record<PushState, string> = {
  on: "This device gets a notification when someone adds an expense.",
  off: "Get a notification on this device when someone adds an expense.",
  denied: "Notifications are blocked for this site. Allow them in your browser settings, then come back.",
  install: "On iPhone and iPad, add Split to your Home Screen first: tap Share, then “Add to Home Screen”, and open it from there.",
  unsupported: "This browser cannot show notifications. New ones still appear on this page.",
};

/** The per-device switch. Push is opt-in: nothing prompts until it is tapped. */
function PushCard() {
  const { t } = useI18n();
  const publicKey = useServerConfig().data?.push_public_key;
  const hintId = useId();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    currentPushState()
      .then((next) => live && setState(next))
      .catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  if (!state) return <Skeleton className="mb-5 h-[88px] rounded-card" />;
  const shown = publicKey || state === "install" ? state : "unsupported";
  const switchable = shown === "on" || shown === "off";

  async function toggle(on: boolean) {
    if (!publicKey) return;
    setBusy(true);
    setFailed(false);
    try {
      setState(on ? await enablePush(publicKey) : await disablePush());
    } catch {
      setFailed(true);
      setState(await currentPushState().catch(() => "off" as const));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5 flex flex-col gap-3 p-4">
      <label className={cx("flex items-start justify-between gap-4", switchable && "cursor-pointer")}>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-body">{t("Push notifications")}</span>
          <span id={hintId} className="mt-1 block text-[13px] leading-relaxed text-muted">
            {t(PUSH_HINT[shown])}
          </span>
        </span>
        {switchable && (
          <Switch
            checked={shown === "on"}
            disabled={busy}
            onChange={toggle}
            aria-label={t("Push notifications")}
            aria-describedby={hintId}
            className="mt-0.5"
          />
        )}
      </label>
      <FormError message={failed ? "Could not turn on notifications. Try again." : null} />
    </Card>
  );
}

function Row({ notification: n, fresh, now }: { notification: AppNotification; fresh: boolean; now: Date }) {
  const { t, language } = useI18n();
  const locale = language === "ru" ? "ru-RU" : "en-US";
  const actor = n.actor_name ?? t("Someone");
  const content = (
    <>
      <span className="relative mt-0.5">
        <Avatar name={actor} size={36} />
        {fresh && (
          <span className="absolute -left-0.5 -top-0.5 size-3 rounded-full bg-danger ring-2 ring-surface">
            <span className="sr-only">{t("New")}</span>
          </span>
        )}
      </span>
      {/* The share sits under the sentence, not beside the total: on a phone a
          second right-hand column squeezes the title into four lines. */}
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          <span className={cx("min-w-0 text-sm leading-snug text-body", fresh && "font-medium")}>
            {t("{name} added “{title}”", { name: actor, title: n.title })}
          </span>
          <Money minor={n.total} currency={n.currency} className="shrink-0 text-sm font-medium" />
        </span>
        {n.share > 0 && (
          <span className="mt-1 block text-[13px] text-body">
            {t("your share {amount}", { amount: formatMoney(n.share, n.currency) })}
          </span>
        )}
        <span className="mt-0.5 block truncate text-[12px] text-muted">
          {n.team_name} · <time dateTime={n.created_at}>{relativeTime(n.created_at, now, locale)}</time>
        </span>
      </span>
    </>
  );
  const row = cx("flex items-start gap-3 px-4 py-3.5", fresh && "bg-surface-2/50");
  return n.expense_id ? (
    <Link to={`/teams/${n.team_id}/expenses/${n.expense_id}`} className={cx(row, ROW_PRESS)}>
      {content}
    </Link>
  ) : (
    <div className={row}>{content}</div>
  );
}

export default function NotificationsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const notifications = useNotifications();
  const { mutate: markRead } = useMarkNotificationsRead();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => new Date());

  // Opening the page reads everything on it, so the badge clears at once; what
  // was new stays marked as new until the page is left.
  const unreadKey = (notifications.data?.items ?? []).filter((n) => !n.read).map((n) => n.id).join(",");
  useEffect(() => {
    if (!unreadKey) return;
    const ids = unreadKey.split(",");
    setFresh((current) => new Set([...current, ...ids]));
    markRead(ids);
  }, [unreadKey, markRead]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const from = (location.state as { from?: unknown } | null)?.from;
  const back =
    typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/notifications")
      ? { to: from, label: t("Back") }
      : { to: "/", label: t("All teams") };

  return (
    <AppShell back={back} narrow>
      <PageTitle title={t("Notifications")} subtitle={t("What the people you share with have added.")} />
      <PushCard />

      {notifications.isPending && (
        <Card className="divide-y divide-line overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </Card>
      )}

      {notifications.isError && (
        <Card>
          <ErrorState
            message={notifications.error instanceof ApiError ? notifications.error.message : t("Could not load notifications.")}
            onRetry={() => notifications.refetch()}
          />
        </Card>
      )}

      {notifications.data && notifications.data.items.length === 0 && (
        <Card>
          <EmptyState
            title={t("No notifications yet")}
            body={t("When someone in your teams adds an expense, it shows up here.")}
          />
        </Card>
      )}

      {notifications.data && notifications.data.items.length > 0 && (
        <Card className="divide-y divide-line overflow-hidden">
          {notifications.data.items.map((n) => (
            <Row key={n.id} notification={n} fresh={fresh.has(n.id) || !n.read} now={now} />
          ))}
        </Card>
      )}
    </AppShell>
  );
}
