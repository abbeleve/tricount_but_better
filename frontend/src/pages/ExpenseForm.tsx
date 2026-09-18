import { useMutation } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell, BackLink, PageTitle } from "../components/Layout";
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
import type { Expense, Member, ParsedReceiptItem, Receipt } from "../lib/types";

type Mode = "total" | "items";

interface ItemDraft {
  key: string;
  name: string;
  amount: string;
  userIds: string[];
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
    <div className="flex flex-wrap gap-1.5">
      {members.map((member) => {
        const on = selected.includes(member.user_id);
        return (
          <button
            key={member.user_id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(member.user_id)}
            className={cx(
              "rounded-full border transition-all active:translate-y-px",
              size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[13px]",
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
  const [mode, setMode] = useState<Mode>("total");
  const [scanning, setScanning] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [payerId, setPayerId] = useState("");
  const [spentAt, setSpentAt] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [customWeights, setCustomWeights] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([]);

  /* Defaults for a new expense: me paying, everyone splitting. */
  if (!editing && !loaded && team.data && user) {
    setLoaded(true);
    setPayerId(user.id);
    setParticipants(members.map((m) => m.user_id));
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
    setMode(e.split_mode);
    if (e.split_mode === "total") {
      setAmount(toMajorString(e.total, e.currency));
      setParticipants(e.shares.map((s) => s.user_id));
      const nextWeights: Record<string, string> = {};
      let mixed = false;
      for (const share of e.shares) {
        nextWeights[share.user_id] = share.weight ?? "1";
        if (share.weight && share.weight !== e.shares[0].weight) mixed = true;
      }
      setWeights(nextWeights);
      setCustomWeights(mixed);
    } else {
      setItems(
        e.items.map((item) => ({
          key: nextKey(),
          name: item.name,
          amount: toMajorString(item.total, e.currency),
          userIds: item.shares.map((s) => s.user_id),
        })),
      );
    }
  }

  const totalMinor = toMinor(amount, currency);

  /* Live preview, computed with the same algorithm the server uses. */
  const previewShares = useMemo(() => {
    if (mode !== "total" || totalMinor === null || participants.length === 0) return null;
    const w = participants.map((id) => Number(weights[id] ?? "1") || 0);
    if (w.every((x) => x === 0)) return null;
    const split = previewEqualSplit(totalMinor, w);
    return participants.map((id, i) => ({ userId: id, amount: split[i] }));
  }, [mode, totalMinor, participants, weights]);

  const itemsTotal = useMemo(
    () => items.reduce((sum, item) => sum + (toMinor(item.amount, currency) ?? 0), 0),
    [items, currency],
  );

  const itemPreview = useMemo(() => {
    if (mode !== "items") return null;
    const perUser = new Map<string, number>();
    for (const item of items) {
      const value = toMinor(item.amount, currency);
      if (value === null || item.userIds.length === 0) continue;
      const split = previewEqualSplit(value, item.userIds.map(() => 1));
      item.userIds.forEach((id, i) => perUser.set(id, (perUser.get(id) ?? 0) + split[i]));
    }
    return perUser;
  }, [mode, items, currency]);

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
      const body =
        mode === "total"
          ? {
              ...base,
              split_mode: "total",
              total: totalMinor,
              shares: participants.map((id) => ({
                user_id: id,
                weight: customWeights ? (weights[id] ?? "1") : "1",
              })),
            }
          : {
              ...base,
              split_mode: "items",
              receipt_id: receiptId,
              items: items.map((item) => ({
                name: item.name.trim(),
                total: toMinor(item.amount, currency) ?? 0,
                shares: item.userIds.map((id) => ({ user_id: id, weight: "1" })),
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
  if (!title.trim()) problems.push("Give it a name.");
  if (mode === "total") {
    if (totalMinor === null) problems.push("Enter an amount.");
    if (participants.length === 0) problems.push("Pick at least one person to split it between.");
  } else {
    if (items.length === 0) problems.push("Add at least one line.");
    if (items.some((i) => !i.name.trim())) problems.push("Every line needs a name.");
    if (items.some((i) => toMinor(i.amount, currency) === null))
      problems.push("Every line needs an amount.");
    if (items.some((i) => i.userIds.length === 0))
      problems.push("Every line needs at least one person on it.");
  }
  const valid = problems.length === 0;

  /* ------------------------------------------------------------- render */

  if (team.isPending || (editing && existing.isPending)) {
    return (
      <AppShell>
        <Skeleton className="mb-6 h-9 w-56" />
        <Card className="h-96" />
      </AppShell>
    );
  }

  const updateItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  function applyParsed(receipt: Receipt, parsed: ParsedReceiptItem[]) {
    setReceiptId(receipt.id);
    setMode("items");
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
  }

  return (
    <AppShell>
      <BackLink to={`/teams/${teamId}?tab=expenses`}>Back to {team.data?.name}</BackLink>
      <PageTitle title={editing ? "Edit expense" : "Add an expense"} />

      {scanning && (
        <div className="mb-4">
          <ReceiptScanner teamId={teamId} onParsed={applyParsed} onCancel={() => setScanning(false)} />
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4 p-5">
          <Field label="What was it?">
            {(id) => (
              <Input
                id={id}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekly shop"
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Who paid?">
              {(id) => (
                <Select id={id} value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.display_name}
                      {m.user_id === user?.id ? " (you)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="When?">
              {(id) => (
                <Input id={id} type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} />
              )}
            </Field>
          </div>

          <Field label="Category" hint="Optional, but it makes the breakdown useful.">
            {(id) => (
              <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">No category</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </Card>

        {/* ----------------------------------------------------- split mode */}
        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label="How to split"
              className="inline-flex rounded-control border border-line bg-surface-2 p-0.5"
            >
              {(["total", "items"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={cx(
                    "rounded-[7px] px-3 py-1.5 text-[13px] transition-colors",
                    mode === m
                      ? "bg-surface font-medium text-body shadow-sm"
                      : "text-muted hover:text-body",
                  )}
                >
                  {m === "total" ? "One total" : "Line by line"}
                </button>
              ))}
            </div>

            {config.data?.receipt_scanning && !scanning && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setScanning(true)}>
                Scan a receipt
              </Button>
            )}
          </div>

          {mode === "total" ? (
            <>
              <Field label={`Amount (${currency})`}>
                {(id) => (
                  <MoneyInput
                    id={id}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                  />
                )}
              </Field>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium text-body">Split between</span>
                  <button
                    type="button"
                    onClick={() => setCustomWeights((c) => !c)}
                    className="text-[12px] text-muted underline underline-offset-4 hover:text-body"
                  >
                    {customWeights ? "Split equally" : "Use custom shares"}
                  </button>
                </div>
                <PeoplePicker
                  members={members}
                  selected={participants}
                  onToggle={(id) =>
                    setParticipants((list) =>
                      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
                    )
                  }
                />
              </div>

              {previewShares && (
                <ul className="flex flex-col divide-y divide-line rounded-control bg-surface-2 px-3">
                  {previewShares.map(({ userId, amount: share }) => {
                    const member = members.find((m) => m.user_id === userId);
                    return (
                      <li key={userId} className="flex items-center justify-between gap-3 py-2.5">
                        <span className="truncate text-[13px] text-body">{member?.display_name}</span>
                        <div className="flex items-center gap-3">
                          {customWeights && (
                            <input
                              aria-label={`Share weight for ${member?.display_name}`}
                              inputMode="decimal"
                              value={weights[userId] ?? "1"}
                              onChange={(e) =>
                                setWeights((w) => ({ ...w, [userId]: e.target.value }))
                              }
                              className="tabular h-7 w-14 rounded-control border border-line bg-surface px-2 text-right text-[13px]"
                            />
                          )}
                          <Money minor={share} currency={currency} className="text-[13px]" />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <>
              <p className="text-[13px] text-muted">
                Each line is split equally between the people highlighted on it. Turn someone off a
                line and they pay nothing towards it.
              </p>

              {items.length === 0 && (
                <p className="rounded-control bg-surface-2 px-3 py-6 text-center text-sm text-muted">
                  No lines yet. Add one by hand, or scan a receipt.
                </p>
              )}

              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <li key={item.key} className="rounded-control border border-line p-3">
                    <div className="mb-2.5 flex gap-2">
                      <Input
                        aria-label="Item name"
                        value={item.name}
                        onChange={(e) => updateItem(item.key, { name: e.target.value })}
                        placeholder="Item"
                        className="flex-1"
                      />
                      <MoneyInput
                        aria-label="Item amount"
                        value={item.amount}
                        onChange={(e) => updateItem(item.key, { amount: e.target.value })}
                        placeholder="0.00"
                        className="w-28"
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${item.name || "item"}`}
                        onClick={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                        className="grid size-10 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-body active:translate-y-px"
                      >
                        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </div>
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
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setItems((list) => [
                      ...list,
                      { key: nextKey(), name: "", amount: "", userIds: members.map((m) => m.user_id) },
                    ])
                  }
                >
                  Add a line
                </Button>
                <p className="text-sm text-muted">
                  Total <Money minor={itemsTotal} currency={currency} className="font-medium" />
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
            </>
          )}
        </Card>

        <Card className="p-5">
          <Field label="Note" hint="Anything worth remembering later.">
            {(id) => (
              <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />
            )}
          </Field>
        </Card>

        <FormError message={save.error instanceof ApiError ? save.error.message : null} />
        {!valid && title.length > 0 && (
          <p className="text-[13px] text-muted">{problems[0]}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={save.isPending} disabled={!valid}>
            {editing ? "Save changes" : "Add expense"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(`/teams/${teamId}?tab=expenses`)}>
            Cancel
          </Button>
          {editing && (
            <Button
              type="button"
              variant="danger"
              className="sm:ml-auto"
              loading={remove.isPending}
              onClick={() => {
                if (window.confirm("Delete this expense? Balances will be recalculated.")) {
                  remove.mutate(expenseId!, {
                    onSuccess: () => navigate(`/teams/${teamId}?tab=expenses`),
                  });
                }
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </form>
    </AppShell>
  );
}
