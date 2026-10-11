import { useMutation } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { ReceiptScanner } from "../components/ReceiptScanner";
import { CategoryPicker } from "../components/CategoryPicker";
import { BasketComparison, PriceVerdict } from "../components/PriceViz";
import { PriceReview } from "../components/PriceReview";
import { ProductLinker, TagIcon } from "../components/ProductLinker";
import { CameraIcon, ScanPanel } from "../components/ScanButton";
import { ShopMatchCard, ShopPicker } from "../components/ShopPicker";
import {
  Button,
  Card,
  ErrorState,
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
  useDeleteExpense,
  useExpense,
  usePlan,
  useProducts,
  useReviewPrices,
  useServerConfig,
  useShops,
  useTeam,
  useTeamInvalidation,
} from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { useScanFlow } from "../hooks/useScanFlow";
import { ApiError, api } from "../lib/api";
import { todayLocal } from "../lib/dates";
import { previewEqualSplit, toMajorString, toMinor } from "../lib/money";
import { useI18n } from "../lib/i18n";
import { basketElsewhere, initialAnswers, paidPerUnit, receiptVsUsual } from "../lib/prices";
import type {
  Expense, Member, ParsedReceiptItem, PriceAnswer, Product, ReceiptScan, ShopMatch,
} from "../lib/types";

interface ItemDraft {
  key: string;
  name: string;
  amount: string;
  userIds: string[];
  weights?: Record<string, string>;
  quantity?: string;
  unitPrice?: number;
  /* Price tracking; only sent along when the expense has a shop. */
  productId?: string;
  productName?: string;
  productMatch?: "receipt" | "model" | "name" | null;
  track?: boolean;
  onSale?: boolean;
  regularUnitPrice?: number;
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
  const [params] = useSearchParams();
  const planId = expenseId ? null : params.get("planId");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useI18n();
  const team = useTeam(teamId);
  const config = useServerConfig();
  const existing = useExpense(teamId, expenseId);
  const planned = usePlan(teamId, planId);
  const invalidate = useTeamInvalidation(teamId);
  const remove = useDeleteExpense(teamId);
  const shops = useShops(teamId);
  const reviewPrices = useReviewPrices(teamId);

  const editing = Boolean(expenseId);
  const members = team.data?.members ?? [];
  const currency = team.data?.currency ?? "RUB";

  const [loaded, setLoaded] = useState(false);
  const [planLoaded, setPlanLoaded] = useState(false);
  const scan = useScanFlow();

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [payerId, setPayerId] = useState("");
  const [spentAt, setSpentAt] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState("");
  const [shopId, setShopId] = useState("");
  /** What the last scan said about the shop, until it is acknowledged. */
  const [shopNotice, setShopNotice] = useState<{ match: ShopMatch; merchant: string | null } | null>(null);
  /** After saving: prices that differ from the shop's saved ones, awaiting answers. */
  const [review, setReview] = useState<PriceAnswer[] | null>(null);
  const [items, setItems] = useState<ItemDraft[]>([]);
  /** The line just added by hand, so its name field can take focus. */
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const spentAtTouched = useRef(false);

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
    setShopId(e.shop_id ?? "");
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
          quantity: item.quantity,
          unitPrice: item.unit_price,
          productId: item.product_id ?? undefined,
          // A line saved at a shop without a product was kept out on purpose.
          track: item.product_id !== null || !e.shop_id,
          onSale: item.on_sale,
          regularUnitPrice: item.regular_unit_price ?? undefined,
        })));
  }

  if (planId && !planLoaded && planned.data && team.data) {
    setPlanLoaded(true);
    setTitle(planned.data.title);
    setNote(planned.data.note);
    setCategoryId(planned.data.category_id ?? "");
    setItems(planned.data.items.map((item) => ({
      key: nextKey(),
      name: item.name,
      amount: item.total === null ? "" : toMajorString(item.total, currency),
      userIds: members.map((member) => member.user_id),
    })));
  }

  const itemsTotal = useMemo(
    () => items.reduce((sum, item) => sum + (toMinor(item.amount, currency) ?? 0), 0),
    [items, currency],
  );

  /* What the linked goods cost elsewhere, for the comparisons under each line. */
  const productIds = useMemo(
    () => [...new Set(items.flatMap((item) => (item.track !== false && item.productId ? [item.productId] : [])))].sort(),
    [items],
  );
  const linked = useProducts(teamId, { ids: productIds, limit: 200 }, Boolean(shopId) && productIds.length > 0);
  const productsById = useMemo(
    () => new Map<string, Product>((linked.data?.items ?? []).map((product) => [product.id, product])),
    [linked.data],
  );
  const basket = useMemo(() => {
    const lines = items
      .filter((item) => item.track !== false && item.productId)
      .map((item) => ({ productId: item.productId!, quantity: item.quantity, total: toMinor(item.amount, currency) ?? 0 }));
    return {
      tracked: lines.length,
      shops: shopId ? basketElsewhere(lines, productsById, shopId) : [],
      vsUsual: shopId ? receiptVsUsual(lines, productsById) : { saved: 0, compared: 0 },
    };
  }, [items, productsById, shopId, currency]);
  const shopName = shops.data?.find((shop) => shop.id === shopId)?.name ?? null;

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
        shop_id: shopId || null,
      };
      const body = {
        ...base,
        split_mode: "items",
        items: items.map((item) => ({
          name: item.name.trim(),
          total: toMinor(item.amount, currency) ?? 0,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          shares: item.userIds.map((id) => ({ user_id: id, weight: item.weights?.[id] ?? "1" })),
          product_id: item.track === false ? null : item.productId ?? null,
          product_name: item.productName || null,
          track: item.track !== false,
          on_sale: Boolean(item.onSale),
          regular_unit_price: item.regularUnitPrice ?? null,
        })),
      };
      return expenseId
        ? api<Expense>(`/teams/${teamId}/expenses/${expenseId}`, { method: "PUT", body })
        : planId
        ? api<Expense>(`/teams/${teamId}/plans/${planId}/complete`, { body })
        : api<Expense>(`/teams/${teamId}/expenses`, { body });
    },
    onSuccess: (expense) => {
      invalidate();
      if (expense.price_changes.length > 0) {
        setReview(initialAnswers(expense.price_changes));
        window.scrollTo({ top: 0 });
      } else {
        navigate(`/teams/${teamId}?tab=expenses`);
      }
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

  const back = {
    to: planId ? `/teams/${teamId}/plans/${planId}` : `/teams/${teamId}?tab=expenses`,
    label: team.data?.name ?? t("Back"),
  };

  if (team.isPending || (editing && existing.isPending) || (planId && planned.isPending)) {
    return (
      <AppShell back={back}>
        <Skeleton className="mb-6 h-9 w-56" />
        <Card className="h-96" />
      </AppShell>
    );
  }

  if (planId && planned.isError) {
    return <AppShell back={back}><Card><ErrorState message={t("Could not load this plan.")} onRetry={() => planned.refetch()} /></Card></AppShell>;
  }

  const updateItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch, ...(patch.userIds ? { weights: undefined } : {}) } : i)));

  function applyParsed(receipt: ReceiptScan, parsed: ParsedReceiptItem[]) {
    const shopTitle = receipt.shop.name || receipt.merchant;
    if (shopTitle && !title) setTitle(shopTitle);
    // A shop already chosen by hand stays; the notice says if the receipt disagrees.
    if (receipt.shop.shop_id && !shopId) setShopId(receipt.shop.shop_id);
    if (receipt.shop.shop_id || receipt.shop.name || receipt.merchant) {
      setShopNotice({ match: receipt.shop, merchant: receipt.merchant });
    }
    if (!editing && !spentAtTouched.current && receipt.purchased_at)
      setSpentAt(receipt.purchased_at);
    // Default: everyone is on every line. Deselecting is the quick edit.
    const everyone = members.map((m) => m.user_id);
    setItems((list) => [...list, ...parsed.map((item) => ({
        key: nextKey(),
        name: item.name,
        amount: toMajorString(item.total, currency),
        userIds: everyone,
        quantity: item.quantity ?? undefined,
        unitPrice: item.unit_price ?? undefined,
        productId: item.product_id ?? undefined,
        productName: item.product_name ?? undefined,
        productMatch: item.product_match,
        track: true,
        onSale: item.on_sale,
        regularUnitPrice: item.regular_unit_price ?? undefined,
    }))]);
    scan.finish();
  }

  function addLine() {
    const key = nextKey();
    setFocusKey(key);
    setItems((list) => [...list, { key, name: "", amount: "", userIds: members.map((m) => m.user_id) }]);
  }

  const scanUnavailable = config.data?.receipt_scanning === false;
  const started = Boolean(title.trim() || items.length);
  const cancel = () => navigate(back.to);

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
            disabled={!valid || scan.scanning}
          >
            {t(editing ? "Save changes" : planId ? "Record purchase" : "Add expense")}
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

  /** Under a line: which product it is, whether it was on sale, and how its price compares. */
  function linePrice(item: ItemDraft) {
    const paid = toMinor(item.amount, currency);
    const product = item.productId ? productsById.get(item.productId) : undefined;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <ProductLinker
            teamId={teamId}
            currency={currency}
            lineName={item.name}
            link={{ productId: item.productId, productName: item.productName, productMatch: item.productMatch, track: item.track !== false }}
            product={product}
            onChange={(link) => updateItem(item.key, link)}
          />
          {item.track !== false && (
            <button
              type="button"
              aria-pressed={Boolean(item.onSale)}
              onClick={() => updateItem(item.key, { onSale: !item.onSale })}
              className={cx(
                "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
                "active:scale-[0.95] active:duration-0 pointer-coarse:px-3 pointer-coarse:py-1.5",
                item.onSale ? "border-transparent bg-price-low-soft text-price-low" : "border-line text-muted hover:text-body",
              )}
            >
              {t("% On sale")}
            </button>
          )}
        </div>
        {item.track !== false && product && paid !== null && paid > 0 && (
          <PriceVerdict paid={paidPerUnit(paid, item.quantity)} product={product} shopId={shopId} currency={currency} className="self-start" />
        )}
      </div>
    );
  }

  if (review) {
    const done = () => navigate(`/teams/${teamId}?tab=expenses`);
    const reviewBar = (
      <div className="flex flex-col gap-2">
        <FormError message={reviewPrices.error instanceof ApiError ? reviewPrices.error.message : null} />
        <div className="flex gap-2">
          <Button type="button" full className="sm:w-auto" loading={reviewPrices.isPending}
            onClick={() => reviewPrices.mutate(review, { onSuccess: done })}>
            {t("Save prices")}
          </Button>
          <Button type="button" variant="ghost" disabled={reviewPrices.isPending} onClick={done}>
            {t("Decide later")}
          </Button>
        </div>
      </div>
    );
    return (
      <AppShell back={{ to: `/teams/${teamId}?tab=expenses`, label: team.data?.name ?? t("Back") }} bar={reviewBar}>
        <PageTitle
          title={t(review.length === 1 ? "A price has changed" : "Some prices have changed")}
          subtitle={t("The expense is saved. Should these become the shop's prices?")}
        />
        <Card className="p-4 sm:p-5">
          <PriceReview answers={review} onChange={setReview} currency={currency} />
        </Card>
        <p className="mt-3 px-1 text-[12px] text-muted">
          {t("Decide later, and they wait under Prices, marked “price changed”.")}
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell back={back} bar={bar}>
      <PageTitle title={t(editing ? "Edit expense" : planId ? "Complete purchase" : "Add an expense")}
        subtitle={planId ? t("Fill in the prices and choose who shares each item.") : undefined} />

      {/* Keep the photo action visible even after the user has typed lines. */}
      <ScanPanel
        flow={scan}
        className="mb-4"
        title={t(editing || started ? "Add from receipt" : "Scan a receipt")}
        hint={t(scanUnavailable
          ? "Receipt scanning is not configured on this server."
          : "Upload, drop, or paste receipt photos. On a phone, you can also take a photo.")}
      >
        <ReceiptScanner
          teamId={teamId}
          appendToExisting={items.length > 0}
          onParsed={(receipt) => applyParsed(receipt, receipt.items)}
          onCancel={scan.close}
        />
      </ScanPanel>

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
                <Input id={id} type="date" value={spentAt} onChange={(e) => {
                  spentAtTouched.current = true;
                  setSpentAt(e.target.value);
                }} />
              )}
            </Field>
          </div>
          <ShopPicker
            teamId={teamId}
            value={shopId}
            onChange={setShopId}
            hint={t("Optional. Each line's price is remembered for this shop, so you can compare.")}
          />
          {shopNotice && (
            <ShopMatchCard
              teamId={teamId}
              match={shopNotice.match}
              merchant={shopNotice.merchant}
              shopId={shopId}
              onPick={setShopId}
              onDismiss={() => setShopNotice(null)}
            />
          )}
        </Card>

        {/* ----------------------------------------------------- line items */}
        <div
          ref={scan.resultsRef}
          className="scroll-mt-[calc(var(--header-h)+env(safe-area-inset-top)+1rem)]"
        >
          <Card className="flex flex-col gap-4 p-4 sm:p-5">
            <p className="text-[13px] text-muted">
              {t("Each line is split equally between the people highlighted on it. Turn someone off a line and they pay nothing towards it.")}
            </p>

            {items.length === 0 && (
              <p className="hatch rounded-control bg-surface-2 px-3 py-6 text-center text-sm text-muted">
                {t("No lines yet. Add one by hand, or scan a receipt.")}
              </p>
            )}
            {items.length > 0 && !shopId && (
              <p className="-mt-1 flex items-center gap-1.5 text-[12px] text-muted">
                <TagIcon />
                {t("Choose where you bought it to remember these prices and compare shops.")}
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
                        "-mr-1.5 grid size-8 shrink-0 place-items-center rounded-button text-muted",
                        "transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2 active:duration-0",
                        "pointer-coarse:-my-0.5 pointer-coarse:size-10",
                      )}
                    >
                      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                  {shopId && linePrice(item)}
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                  {t("Add a line")}
                </Button>
                {!scan.scanning && (editing || started) && (
                  <Button type="button" variant="secondary" size="sm" onClick={scan.open}>
                    <CameraIcon />
                    {t("Add from receipt")}
                  </Button>
                )}
              </div>
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

        {shopId && (basket.shops.length > 0 || basket.vsUsual.saved !== 0) && (
          <Card className="p-4 sm:p-5">
            <h2 className="mb-2 text-sm font-semibold text-body">{t("How this receipt did")}</h2>
            <BasketComparison shops={basket.shops} tracked={basket.tracked} currency={currency}
              shopName={shopName} vsUsual={basket.vsUsual} />
          </Card>
        )}

        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <CategoryPicker
            teamId={teamId}
            value={categoryId}
            onChange={setCategoryId}
            hint={t("Optional, but it makes the breakdown useful.")}
          />
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
