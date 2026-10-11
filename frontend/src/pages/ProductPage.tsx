import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { PriceHistory, ShopPriceBars } from "../components/PriceViz";
import { PriceEditor } from "../components/PriceEditor";
import { PriceReview } from "../components/PriceReview";
import { Button, Card, ErrorState, FormError, Input, Skeleton } from "../components/ui";
import {
  useProduct, useProductMutations, useProducts, useReviewPrices, useTeam,
} from "../hooks/queries";
import { ApiError } from "../lib/api";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { formatMoney } from "../lib/money";
import { formatPercent, shortDate } from "../lib/price-format";
import { initialAnswers, priceSpread } from "../lib/prices";
import type { PriceAnswer, ProductDetail } from "../lib/types";

export default function ProductPage() {
  const { teamId = "", productId = "" } = useParams();
  const { t, language } = useI18n();
  const team = useTeam(teamId);
  const product = useProduct(teamId, productId);
  const currency = team.data?.currency ?? "RUB";
  const back = { to: `/teams/${teamId}?tab=prices`, label: team.data?.name ?? t("Back") };
  const today = todayLocal();
  /** Which shop's price is being edited, or "new" for a shop without one. */
  const [editing, setEditing] = useState<string | null>(null);

  if (product.isPending || team.isPending) {
    return (
      <AppShell back={back}>
        <Skeleton className="mb-6 h-9 w-64" />
        <Card className="h-64" />
      </AppShell>
    );
  }
  if (product.isError || !product.data) {
    return (
      <AppShell back={back}>
        <Card>
          <ErrorState
            message={product.error instanceof ApiError && product.error.status === 404
              ? t("This product is gone. It may have been merged into another one.")
              : t("Could not load this product.")}
            onRetry={() => product.refetch()}
          />
        </Card>
      </AppShell>
    );
  }

  const data = product.data;
  const best = data.prices.find((row) => row.shop_id === data.best_shop_id);
  const spread = priceSpread(data);

  return (
    <AppShell back={back}>
      <PageTitle
        title={data.name}
        subtitle={data.last_bought_on
          ? t("Bought {count} times · last on {date}", { count: data.purchase_count, date: shortDate(data.last_bought_on, language, true) })
          : t("Not bought yet")}
      />
      <div className="flex flex-col gap-4">
        {data.pending.length > 0 && <PendingCard teamId={teamId} product={data} currency={currency} />}

        <Card className="p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-body">{t("Where it is cheapest")}</h2>
          {best && data.best_price !== null ? (
            <div className="mb-5 mt-3">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-semibold tracking-tight text-body">{formatMoney(data.best_price, currency)}</span>
                <span className="text-sm text-muted">{t("at {shop}", { shop: best.shop_name })}</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">
                {spread
                  ? t("Up to {amount} more elsewhere (+{percent}%).", {
                      amount: formatMoney(spread.max - spread.min, currency),
                      percent: formatPercent(((spread.max - spread.min) / Math.max(spread.min, 1)) * 100, language),
                    })
                  : t("Only one shop has a price so far. Buy it elsewhere, or add a price you saw, to compare.")}
              </p>
            </div>
          ) : (
            <p className="mb-4 mt-1 text-[13px] text-muted">{t("No current price at any shop.")}</p>
          )}
          <ShopPriceBars
            product={data}
            currency={currency}
            today={today}
            onEdit={(shopId) => setEditing(shopId)}
            editing={editing && editing !== "new" ? {
              shopId: editing,
              node: <PriceEditor key={editing} teamId={teamId} product={data} currency={currency}
                shopId={editing} onDone={() => setEditing(null)} />,
            } : null}
          />
          <div className="mt-4">
            {editing === "new" ? (
              <PriceEditor teamId={teamId} product={data} currency={currency} onDone={() => setEditing(null)} />
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                {t("Add a price at another shop")}
              </Button>
            )}
          </div>
        </Card>

        {data.history.some((point) => point.shop_id) && (
          <Card className="p-4 sm:p-5">
            <h2 className="mb-1 text-sm font-semibold text-body">{t("What you paid")}</h2>
            <p className="mb-4 text-[12px] text-muted">{t("Every purchase, per unit, by shop.")}</p>
            <PriceHistory history={data.history} prices={data.prices} currency={currency} />
            <details className="mt-4 border-t border-line pt-3">
              <summary className="cursor-pointer text-[12px] font-medium text-muted hover:text-body">{t("View all purchases")}</summary>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t("Date")}</th>
                      <th className="py-2 pr-3 font-medium">{t("Shop")}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("Per unit")}</th>
                      <th className="py-2 font-medium">{t("Quantity")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {[...data.history].reverse().map((point, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap py-2 pr-3">
                          <Link to={`/teams/${teamId}/expenses/${point.expense_id}`} className="underline-offset-2 hover:underline">
                            {shortDate(point.spent_at, language, true)}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{point.shop_name ?? t("No shop")}</td>
                        <td className="whitespace-nowrap py-2 pr-3 text-right tabular">
                          {formatMoney(point.price, currency)}
                          {point.on_sale && <span className="ml-1.5 text-price-low">{t("sale")}</span>}
                        </td>
                        <td className="py-2 tabular">{Number(point.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </Card>
        )}

        {data.aliases.length > 0 && (
          <Card className="p-4 sm:p-5">
            <h2 className="mb-1 text-sm font-semibold text-body">{t("On receipts")}</h2>
            <p className="mb-3 text-[12px] text-muted">{t("How each shop prints it. A line printed this way is linked here by itself.")}</p>
            <ul className="divide-y divide-line">
              {data.aliases.map((alias) => (
                <li key={`${alias.shop_id}-${alias.name}`} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                  <span className="truncate font-mono text-body">{alias.name}</span>
                  <span className="shrink-0 text-muted">{alias.shop_name}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <ManageCard teamId={teamId} product={data} />
      </div>
    </AppShell>
  );
}

function PendingCard({ teamId, product, currency }: { teamId: string; product: ProductDetail; currency: string }) {
  const { t } = useI18n();
  const review = useReviewPrices(teamId);
  const [answers, setAnswers] = useState<PriceAnswer[]>(() => initialAnswers(product.pending));
  const key = product.pending.map((c) => `${c.shop_id}${c.observed_on}${c.price}`).join();
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setAnswers(initialAnswers(product.pending));
  }

  return (
    <Card className="border-line-strong p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-body">{t("Price changed")}</h2>
      <p className="mb-2 text-[13px] text-muted">{t("A receipt shows a different price from the saved one. Which is it?")}</p>
      <PriceReview answers={answers} onChange={setAnswers} currency={currency} />
      <FormError message={review.error?.message ?? null} />
      <Button className="mt-3" loading={review.isPending} onClick={() => review.mutate(answers)}>{t("Save prices")}</Button>
    </Card>
  );
}

function ManageCard({ teamId, product }: { teamId: string; product: ProductDetail }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { rename, merge, remove } = useProductMutations(teamId, product.id);
  const [name, setName] = useState(product.name);
  const [search, setSearch] = useState("");
  const candidates = useProducts(teamId, { q: search.trim(), limit: 8 }, search.trim().length > 0);

  return (
    <Card className="flex flex-col gap-5 p-4 sm:p-5">
      <div>
        <h2 className="mb-3 text-sm font-semibold text-body">{t("Name")}</h2>
        <div className="flex gap-2">
          <Input aria-label={t("Name")} value={name} maxLength={200} onChange={(e) => { setName(e.target.value); rename.reset(); }} />
          <Button variant="secondary" loading={rename.isPending} disabled={!name.trim() || name.trim() === product.name}
            onClick={() => rename.mutate(name.trim())}>
            {t("Rename")}
          </Button>
        </div>
        <FormError message={rename.error?.message ?? null} />
      </div>

      <div className="border-t border-line pt-4">
        <h2 className="text-sm font-semibold text-body">{t("Same product as another?")}</h2>
        <p className="mb-3 mt-1 text-[12px] text-muted">
          {t("Shops name one good differently. Merge them and its prices compare across those shops.")}
        </p>
        <Input type="search" aria-label={t("Search goods")} placeholder={t("Search goods")} value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <ul className="mt-2 flex flex-col">
          {candidates.data?.items.filter((item) => item.id !== product.id).map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate text-[13px] text-body">{item.name}</span>
              <Button size="sm" variant="secondary" loading={merge.isPending && merge.variables === item.id}
                onClick={() => {
                  if (window.confirm(t("Merge “{from}” into “{into}”? Its purchases and prices move there.", { from: product.name, into: item.name }))) {
                    merge.mutate(item.id, { onSuccess: (merged) => navigate(`/teams/${teamId}/goods/${merged.id}`, { replace: true }) });
                  }
                }}>
                {t("Merge into this")}
              </Button>
            </li>
          ))}
        </ul>
        <FormError message={merge.error?.message ?? null} />
      </div>

      <div className="border-t border-line pt-4">
        <Button variant="danger" loading={remove.isPending}
          onClick={() => {
            if (window.confirm(t("Stop tracking “{name}”? Its expense lines stay, without prices.", { name: product.name }))) {
              remove.mutate(undefined, { onSuccess: () => navigate(`/teams/${teamId}?tab=prices`, { replace: true }) });
            }
          }}>
          {t("Stop tracking")}
        </Button>
      </div>
    </Card>
  );
}
