import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { ReceiptScanner } from "../components/ReceiptScanner";
import {
  Button,
  Card,
  Field,
  FormError,
  Input,
  Money,
  MoneyInput,
  Select,
  Skeleton,
  Textarea,
  cx,
} from "../components/ui";
import {
  useCategories,
  useDeleteExpense,
  useExpense,
  useServerConfig,
  useTeam,
  useTeamInvalidation,
} from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { ApiError, api } from "../lib/api";
import { todayLocal } from "../lib/dates";
import { previewEqualSplit, toMajorString, toMinor } from "../lib/money";
import { useI18n } from "../lib/i18n";
import type { Expense, Member, ParsedReceiptItem, Receipt } from "../lib/types";

interface ItemDraft {
  key: string;
  name: string;
  amount: string;
  userIds: string[];
  weights?: Record<string, string>;
}

let counter = 0;
const nextKey = () => `draft-${counter++}`;

/* ------------------------------------------------------ participant picker */

/**
 * Toggling who is in on something. Names rather than avatars alone: at three
 * people an initial is ambiguous, and this is the control that decides who pays.
 */
function PeoplePicker({
  members,
  selected,
  onToggle,
  size = "md",
}: {
  members: Member[];
  selected: string[];
  onToggle: (userId: string) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2">
      {members.map((member) => {
        const on = selected.includes(member.user_id);
        return (
          <button
            key={member.user_id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(member.user_id)}
            className={cx(
              // Thumb-sized on a touch screen: this is the control that decides who pays.
              "inline-flex items-center rounded-full border",
              "transition duration-150 ease-out active:scale-[0.95] active:duration-0",
              size === "sm"
                ? "h-7 px-2.5 text-[12px] pointer-coarse:h-9 pointer-coarse:px-3.5 pointer-coarse:text-sm"
                : "h-8 px-3 text-[13px] pointer-coarse:h-10 pointer-coarse:px-4 pointer-coarse:text-sm",
              on
                ? "border-ink bg-ink font-medium text-ink-text"
                : "border-line bg-surface text-muted hover:border-line-strong hover:text-body",
            )}
          >
            {member.display_name}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- page */

export default function ExpenseForm() {
  const { teamId = "", expenseId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useI18n();
  const team = useTeam(teamId);
  const categories = useCategories(teamId);
  const config = useServerConfig();
  const existing = useExpense(teamId, expenseId);
  const invalidate = useTeamInvalidation(teamId);
  const remove = useDeleteExpense(teamId);

  const editing = Boolean(expenseId);
  const members = team.data?.members ?? [];
  const currency = team.data?.currency ?? "RUB";

  const [loaded, setLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [payerId, setPayerId] = useState("");
  const [spentAt, setSpentAt] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  /** The line just added by hand, so its name field can take focus. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [revealLines, setRevealLines] = useState(0);
  const splitRef = useRef<HTMLDivElement>(null);

  // After a scan the lines are the thing to check, so bring them into view.
  useEffect(() => {
    if (!revealLines) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    splitRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [revealLines]);

  /* Defaults for a new expense: me paying, everyone splitting. */
  if (!editing && !loaded && team.data && user) {
    setLoaded(true);
    setPayerId(user.id);
  }

  /* Populate from an existing expense exactly once. */
  if (editing && !loaded && existing.data && team.data) {
    setLoaded(true);
    const e: Expense = existing.data;
    setTitle(e.title);
    setNote(e.note);
    setPayerId(e.payer_id);
    setSpentAt(e.spent_at);
    setCategoryId(e.category_id ?? "");
    setReceiptId(e.receipt_id);
    setItems(e.split_mode === "total"
      ? [{
          key: nextKey(),
          name: e.title,
          amount: toMajorString(e.total, e.currency),
          userIds: e.shares.map((share) => share.user_id),
          // Keep a historical weighted split exact until its participant list is changed.
          weights: Object.fromEntries(e.shares.map((share) => [share.user_id, String(Math.abs(share.amount) || (e.total === 0 ? 1 : 0))])),
        }]
      : e.items.map((item) => ({
          key: nextKey(),
          name: item.name,
          amount: toMajorString(item.total, e.currency),
          userIds: item.shares.map((share) => share.user_id),
          weights: Object.fromEntries(item.shares.map((share) => [share.user_id, share.weight ?? "1"])),
        })));
  }

  const itemsTotal = useMemo(
    () => items.reduce((sum, item) => sum + (toMinor(item.amount, currency) ?? 0), 0),
    [items, currency],
  );

  const itemPreview = useMemo(() => {
    const perUser = new Map<string, number>();
    for (const item of items) {
      const value = toMinor(item.amount, currency);
      if (value === null || item.userIds.length === 0) continue;
      const split = previewEqualSplit(value, item.userIds.map((id) => Number(item.weights?.[id] ?? "1")));
      item.userIds.forEach((id, i) => perUser.set(id, (perUser.get(id) ?? 0) + split[i]));
    }
    return perUser;
  }, [items, currency]);

  /* ------------------------------------------------------------- submit */

  const save = useMutation({
    mutationFn: () => {
      const base = {
        title: title.trim(),
        payer_id: payerId,
        spent_at: spentAt,
        note,
        category_id: categoryId || null,
      };
      const body = {
        ...base,
        split_mode: "items",
        receipt_id: receiptId,
        items: items.map((item) => ({
          name: item.name.trim(),
          total: toMinor(item.amount, currency) ?? 0,
          shares: item.userIds.map((id) => ({ user_id: id, weight: item.weights?.[id] ?? "1" })),
        })),
      };
      return expenseId
        ? api<Expense>(`/teams/${teamId}/expenses/${expenseId}`, { method: "PUT", body })
        : api<Expense>(`/teams/${teamId}/expenses`, { body });
    },
    onSuccess: () => {
      invalidate();
      navigate(`/teams/${teamId}?tab=expenses`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  /* --------------------------------------------------------- validation */

  const problems: string[] = [];
  if (!title.trim()) problems.push(t("Give it a name."));
  if (items.length === 0) problems.push(t("Add at least one line."));
  if (items.some((i) => !i.name.trim())) problems.push(t("Every line needs a name."));
  if (items.some((i) => toMinor(i.amount, currency) === null))
    problems.push(t("Every line needs an amount."));
  if (items.some((i) => i.userIds.length === 0))
    problems.push(t("Every line needs at least one person on it."));
  const valid = problems.length === 0;

  /* ------------------------------------------------------------- render */

  const back = { to: `/teams/${teamId}?tab=expenses`, label: team.data?.name ?? t("Back") };

  if (team.isPending || (editing && existing.isPending)) {
    return (
      <AppShell back={back}>
        <Skeleton className="mb-6 h-9 w-56" />
        <Card className="h-96" />
      </AppShell>
    );
  }

  const updateItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch, ...(patch.userIds ? { weights: undefined } : {}) } : i)));

  function applyParsed(receipt: Receipt, parsed: ParsedReceiptItem[]) {
    setReceiptId(receipt.id);
    setScanning(false);
    if (receipt.merchant && !title) setTitle(receipt.merchant);
    if (receipt.purchased_at) setSpentAt(receipt.purchased_at);
    // Default: everyone is on every line. Deselecting is the quick edit.
    const everyone = members.map((m) => m.user_id);
    setItems(
      parsed.map((item) => ({
        key: nextKey(),
        name: item.name,
        amount: toMajorString(item.total, currency),
        userIds: everyone,
      })),
    );
    setRevealLines((n) => n + 1);
  }

  function addLine() {
    const key = nextKey();
    setFocusKey(key);
    setItems((list) => [...list, { key, name: "", amount: "", userIds: members.map((m) => m.user_id) }]);
  }

  const canScan = Boolean(config.data?.receipt_scanning);
  const started = Boolean(title.trim() || items.length);
  const cancel = () => navigate(`/teams/${teamId}?tab=expenses`);

  /* Pinned to the bottom edge: the primary action never scrolls out of reach. */
  const bar = (
    <div className="flex flex-col gap-2">
      <FormError message={save.error instanceof ApiError ? save.error.message : null} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!valid && started && (
          <p className="text-[13px] text-muted sm:order-last sm:ml-2" aria-live="polite">
            {problems[0]}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            form="expense-form"
            full
            className="sm:w-auto"
            loading={save.isPending}
            disabled={!valid}
          >
            {t(editing ? "Save changes" : "Add expense")}
          </Button>
          {/* Wide screens only: on a phone the header's back button is the way out.
              Wrapped because the button's own display class would beat `hidden`. */}
          <div className="hidden sm:block">
            <Button type="button" variant="ghost" onClick={cancel}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell back={back} bar={bar}>
      <PageTitle title={t(editing ? "Edit expense" : "Add an expense")} />

      {scanning ? (
        <div className="mb-4">
          <ReceiptScanner teamId={teamId} onParsed={applyParsed} onCancel={() => setScanning(false)} />
        </div>
      ) : (
        canScan &&
        !editing && (
          /* On a phone the camera is right there, so the scan is the headline way in. */
          <button
            type="button"
            onClick={() => setScanning(true)}
            className={cx(
              "card mb-4 flex w-full items-center gap-3 p-4 text-left hover:border-line-strong",
              "transition duration-150 ease-out active:scale-[0.98] active:duration-0",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-control bg-ink text-ink-text">
              <CameraIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-body">{t("Scan a receipt")}</span>
              <span className="block text-[13px] text-muted">
                {t("Photograph it, then split it line by line.")}
              </span>
            </span>
            <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-subtle" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </button>
        )
      )}

      <form id="expense-form" onSubmit={submit} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <Field label={t("What was it?")}>
            {(id) => (
              <Input
                id={id}
                required
                autoCapitalize="sentences"
                enterKeyHint="next"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("Weekly shop")}
              />
            )}
          </Field>

          {/* Side by side from 360px: both fit, and the amount moves up the screen. */}
          <div className="grid gap-4 min-[360px]:grid-cols-2 min-[360px]:gap-3">
            <Field label={t("Who paid?")}>
              {(id) => (
                <Select id={id} value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.display_name}
                      {m.user_id === user?.id ? t(" (you)") : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t("When?")}>
              {(id) => (
                <Input id={id} type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} />
              )}
            </Field>
          </div>
        </Card>

        {/* ----------------------------------------------------- line items */}
        <div
          ref={splitRef}
          className="scroll-mt-[calc(var(--header-h)+env(safe-area-inset-top)+1rem)]"
        >
          <Card className="flex flex-col gap-4 p-4 sm:p-5">
            {canScan && editing && !scanning && (
              <div>
                <Button type="button" variant="secondary" size="sm" onClick={() => setScanning(true)}>
                  <CameraIcon />
                  {t("Scan a receipt")}
                </Button>
              </div>
            )}
            <p className="text-[13px] text-muted">
              {t("Each line is split equally between the people highlighted on it. Turn someone off a line and they pay nothing towards it.")}
            </p>

            {items.length === 0 && (
              <p className="rounded-control bg-surface-2 px-3 py-6 text-center text-sm text-muted">
                {t("No lines yet. Add one by hand, or scan a receipt.")}
              </p>
            )}

            {/* A flat list rather than a box per line: on a phone every
                pixel of width goes to the item name. */}
            <ul className="-mt-1 flex flex-col divide-y divide-line">
              {items.map((item) => (
                <li key={item.key} className="flex flex-col gap-2.5 py-3.5 first:pt-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                    <div className="min-w-0">
                      <label htmlFor={`${item.key}-name`} className="mb-1.5 block text-[12px] text-muted">{t("Name")}</label>
                      <Input
                        id={`${item.key}-name`}
                        autoFocus={item.key === focusKey}
                        autoCapitalize="sentences"
                        enterKeyHint="next"
                        value={item.name}
                        onChange={(e) => updateItem(item.key, { name: e.target.value })}
                        placeholder={t("Item")}
                      />
                    </div>
                    <div className="min-w-0">
                      <label htmlFor={`${item.key}-price`} className="mb-1.5 block text-[12px] text-muted">{t("Price")}</label>
                      <MoneyInput
                        id={`${item.key}-price`}
                        enterKeyHint="done"
                        value={item.amount}
                        onChange={(e) => updateItem(item.key, { amount: e.target.value })}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <PeoplePicker
                        size="sm"
                        members={members}
                        selected={item.userIds}
                        onToggle={(id) =>
                          updateItem(item.key, {
                            userIds: item.userIds.includes(id)
                              ? item.userIds.filter((x) => x !== id)
                              : [...item.userIds, id],
                          })
                        }
                      />
                    </div>
                    <button
                      type="button"
                      aria-label={t("Remove {name}", { name: item.name || t("Item") })}
                      onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                      className={cx(
                        "-mr-1.5 grid size-8 shrink-0 place-items-center rounded-control text-muted",
                        "transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2 active:duration-0",
                        "pointer-coarse:-my-0.5 pointer-coarse:size-10",
                      )}
                    >
                      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                {t("Add a line")}
              </Button>
              <p className="text-sm text-muted">
                {t("Total")} <Money minor={itemsTotal} currency={currency} className="font-medium" />
              </p>
            </div>

            {itemPreview && itemPreview.size > 0 && (
              <ul className="flex flex-col divide-y divide-line rounded-control bg-surface-2 px-3">
                {members
                  .filter((m) => itemPreview.has(m.user_id))
                  .map((member) => (
                    <li key={member.user_id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="truncate text-[13px] text-body">{member.display_name}</span>
                      <Money
                        minor={itemPreview.get(member.user_id) ?? 0}
                        currency={currency}
                        className="text-[13px]"
                      />
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <Field label={t("Category")} hint={t("Optional, but it makes the breakdown useful.")}>
            {(id) => (
              <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">{t("No category")}</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("Note")} hint={t("Anything worth remembering later.")}>
            {(id) => (
              <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />
            )}
          </Field>
        </Card>

        {editing && (
          /* Kept away from the save button, down in the page, so it is never hit by reflex. */
          <Button
            type="button"
            variant="danger"
            className="mt-2 w-full sm:w-auto sm:self-start"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm(t("Delete this expense? Balances will be recalculated."))) {
                remove.mutate(expenseId!, { onSuccess: cancel });
              }
            }}
          >
            {t("Delete expense")}
          </Button>
        )}
      </form>
    </AppShell>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5A1.5 1.5 0 0 1 4 6h1.8l1.2-2h6l1.2 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
      <circle cx="10" cy="10.75" r="2.75" />
    </svg>
  );
}
