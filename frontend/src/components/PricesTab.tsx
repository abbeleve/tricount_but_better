import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useCreateProduct, useDeleteShop, useProducts, useServerConfig, useShops, useUpdateShop,
} from "../hooks/queries";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { formatMoney, toMinor } from "../lib/money";
import { formatPercent, shortDate } from "../lib/price-format";
import { pricedRows, priceSpread } from "../lib/prices";
import type { Product, ProductFilter, ProductSort, Shop, TeamDetail } from "../lib/types";
import { SaleChip } from "./PriceViz";
import { SavingsCard } from "./SavingsCard";
import { ScanCard } from "./ScanButton";
import { ShopCreator, ShopPicker } from "./ShopPicker";
import {
  Button, Card, EmptyState, ErrorState, Field, FormError, Input, Money, MoneyInput, ROW_PRESS,
  Select, Skeleton, cx,
} from "./ui";

const FILTERS: { id: ProductFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "compared", label: "In 2+ shops" },
  { id: "sale", label: "On sale" },
  { id: "changed", label: "Price changed" },
];

const SORTS: { id: ProductSort; label: string }[] = [
  { id: "recent", label: "Recently bought" },
  { id: "spread", label: "Biggest price gap" },
  { id: "name", label: "A–Z" },
];

function matches(product: Product, filter: ProductFilter): boolean {
  if (filter === "compared") return pricedRows(product).length >= 2;
  if (filter === "sale") return product.prices.some((row) => row.on_sale);
  if (filter === "changed") return product.pending.length > 0;
  return true;
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; label: string;
}) {
  const { t } = useI18n();
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-segment bg-surface-2 p-1">
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}
          className={cx("rounded-segment-option px-3 py-2 text-[13px] transition-colors",
            value === option.id ? "bg-raised font-medium text-body shadow-raised" : "text-muted hover:text-body")}>
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

export function PricesTab({ team }: { team: TeamDetail }) {
  const { t } = useI18n();
  const [view, setView] = useState<"goods" | "shops">("goods");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h2 className="text-base font-semibold text-body">{t("Prices")}</h2>
          <p className="mt-1 text-[13px] text-muted">
            {t("What your goods cost in each shop, from the receipts you save.")}
          </p>
        </div>
        <Segmented value={view} onChange={setView} label={t("Prices view")}
          options={[{ id: "goods", label: "Goods" }, { id: "shops", label: "Shops" }]} />
      </div>
      {view === "goods" ? <GoodsView team={team} /> : <ShopsView team={team} />}
    </div>
  );
}

function GoodsView({ team }: { team: TeamDetail }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [sort, setSort] = useState<ProductSort>("recent");
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const config = useServerConfig();
  const scanUnavailable = config.data?.receipt_scanning === false;
  // One request for the whole (searched) catalogue: the filter counts come from it.
  const products = useProducts(team.id, { q: search.trim(), sort, limit: 500 });
  const all = useMemo(() => products.data?.items ?? [], [products.data]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((p) => matches(p, f.id)).length])),
    [all],
  );
  const rows = all.filter((product) => matches(product, filter));
  const today = todayLocal();

  return (
    <>
      <SavingsCard teamId={team.id} />
      <ScanCard
        title={t("Read prices from a screenshot")}
        hint={t(scanUnavailable
          ? "Receipt scanning is not configured on this server."
          : "A shop's app or website, a leaflet, or price tags. Upload, drop or paste; on a phone, take a photo.")}
        onClick={() => navigate(`/teams/${team.id}/prices/import`)}
      />
      <div className="flex gap-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("Search goods")}
          aria-label={t("Search goods")}
          enterKeyHint="search"
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        {!adding && (
          <Button variant="secondary" className="shrink-0" onClick={() => setAdding(true)}>
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("Add product")}
          </Button>
        )}
      </div>
      {adding && <NewProduct team={team} initialName={search.trim()} onCancel={() => setAdding(false)} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label={t("Show")} className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
          {FILTERS.map((option) => (
            <button key={option.id} type="button" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}
              className={cx(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors pointer-coarse:h-10",
                filter === option.id ? "border-ink bg-ink font-medium text-ink-text" : "border-line bg-surface text-muted hover:text-body",
              )}>
              {t(option.label)}
              <span className="tabular text-[11px] opacity-70">{counts[option.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <Select aria-label={t("Sort")} value={sort} onChange={(e) => setSort(e.target.value as ProductSort)} className="w-auto">
          {SORTS.map((option) => <option key={option.id} value={option.id}>{t(option.label)}</option>)}
        </Select>
      </div>

      {products.isPending && (
        <Card className="divide-y divide-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4 p-4">
              <div className="flex flex-col gap-2"><Skeleton className="h-4 w-44" /><Skeleton className="h-3 w-28" /></div>
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </Card>
      )}
      {products.isError && <Card><ErrorState message={t("Could not load prices.")} onRetry={() => products.refetch()} /></Card>}

      {products.data && rows.length === 0 && (
        <Card>
          <EmptyState
            title={t(all.length === 0 && !search ? "No prices yet" : "Nothing matched")}
            body={t(all.length === 0 && !search
              ? "Save a receipt with the shop it came from, and every line's price is remembered here, shop by shop."
              : "Try a different word or filter.")}
            action={all.length === 0 && !search
              ? <Link to={`/teams/${team.id}/expenses/new`} className="text-sm font-medium underline underline-offset-4">{t("Scan a receipt")}</Link>
              : undefined}
          />
        </Card>
      )}

      {rows.length > 0 && (
        <Card className={cx("divide-y divide-line overflow-hidden transition-opacity", products.isPlaceholderData && "opacity-60")}>
          {rows.map((product) => <GoodsRow key={product.id} teamId={team.id} product={product} currency={team.currency} today={today} />)}
        </Card>
      )}
      {all.length > 0 && (
        <p className="px-1 text-[11px] text-muted">
          {t("Prices are per piece, or per kilogram for weighed goods. A running sale counts as the shop's price until it ends.")}
        </p>
      )}
    </>
  );
}

/** A good not bought yet -- or bought without a receipt -- with a price someone knows. */
function NewProduct({ team, initialName, onCancel }: {
  team: TeamDetail; initialName: string; onCancel: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const create = useCreateProduct(team.id);
  const [name, setName] = useState(initialName);
  const [shopId, setShopId] = useState("");
  const [price, setPrice] = useState("");
  const minor = price.trim() ? toMinor(price, team.currency) : null;
  const priceOk = !price.trim() || (minor !== null && minor > 0);
  const valid = Boolean(name.trim()) && priceOk && !(price.trim() && !shopId);

  function submit() {
    if (!valid || create.isPending) return;
    create.mutate(
      { name: name.trim(), shopId: shopId || undefined, regularPrice: minor, observedOn: todayLocal() },
      { onSuccess: (product) => navigate(`/teams/${team.id}/goods/${product.id}`) },
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-body">{t("New product")}</h3>
      <Field label={t("Name")}>
        {(id) => (
          <Input id={id} value={name} maxLength={200} autoCapitalize="sentences" placeholder={t("e.g. Milk 3.2% 1 L")}
            onChange={(e) => { setName(e.target.value); create.reset(); }} />
        )}
      </Field>
      <ShopPicker teamId={team.id} value={shopId} onChange={setShopId} hint={t("Optional: where you know its price.")} />
      {shopId && (
        <Field label={t("Regular price")} hint={t("Per piece, or per kilogram")}>
          {(id) => <MoneyInput id={id} value={price} placeholder="0.00" className="max-w-40" onChange={(e) => setPrice(e.target.value)} />}
        </Field>
      )}
      <FormError message={create.error?.message ?? null} />
      <div className="flex flex-wrap gap-2">
        <Button loading={create.isPending} disabled={!valid} onClick={submit}>{t("Add product")}</Button>
        <Button variant="ghost" disabled={create.isPending} onClick={onCancel}>{t("Cancel")}</Button>
      </div>
    </Card>
  );
}

function GoodsRow({ teamId, product, currency, today }: {
  teamId: string; product: Product; currency: string; today: string;
}) {
  const { t, language } = useI18n();
  const priced = pricedRows(product);
  const best = priced[0];
  const spread = priceSpread(product);

  return (
    <Link to={`/teams/${teamId}/goods/${product.id}`} className={cx("block px-4 py-3.5 hover:bg-surface-2", ROW_PRESS)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate font-medium text-body">{product.name}</p>
        {best ? <Money minor={best.price!} currency={currency} className="shrink-0 font-medium" />
          : <span className="shrink-0 text-[13px] text-muted">{t("no price")}</span>}
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[12px] text-muted">
        <p className="flex min-w-0 items-center gap-1.5">
          {product.pending.length > 0 && (
            <span className="shrink-0 rounded-full bg-price-high-soft px-1.5 py-px text-[11px] font-medium text-price-high">
              {t("price changed")}
            </span>
          )}
          {best?.on_sale && <SaleChip until={best.sale_until} today={today} />}
          <span className="truncate">
            {spread
              ? t("{count} shops · up to {amount} more (+{percent}%)", {
                  count: priced.length,
                  amount: formatMoney(spread.max - spread.min, currency),
                  percent: formatPercent(((spread.max - spread.min) / Math.max(spread.min, 1)) * 100, language),
                })
              : product.last_bought_on
                ? t("Last bought {date}", { date: shortDate(product.last_bought_on, language) })
                : t("Not bought yet")}
          </span>
        </p>
        {best && <span className="max-w-32 shrink-0 truncate">{t("at {shop}", { shop: best.shop_name })}</span>}
      </div>
    </Link>
  );
}

function ShopsView({ team }: { team: TeamDetail }) {
  const { t } = useI18n();
  const shops = useShops(team.id);

  return (
    <>
      <Card className="p-4 sm:p-5">
        <h3 className="mb-1 text-sm font-semibold text-body">{t("Your shops")}</h3>
        <p className="mb-3 text-[13px] text-muted">
          {t("Scanned receipts are matched to these by name. Everyone in the team shares them.")}
        </p>
        {shops.isPending && <Skeleton className="h-24 w-full" />}
        {shops.isError && <ErrorState message={t("Could not load shops.")} onRetry={() => shops.refetch()} />}
        {shops.data?.length === 0 && (
          <EmptyState title={t("No shops yet")} body={t("Add one here, or scan a receipt and add the shop it came from.")} />
        )}
        {shops.data && shops.data.length > 0 && (
          <ul className="divide-y divide-line">
            {shops.data.map((shop) => <ShopRow key={shop.id} teamId={team.id} shop={shop} />)}
          </ul>
        )}
      </Card>
      <Card className="p-4 sm:p-5">
        <h3 className="mb-4 text-sm font-semibold text-body">{t("New shop")}</h3>
        <ShopCreator teamId={team.id} />
      </Card>
    </>
  );
}

function ShopRow({ teamId, shop }: { teamId: string; shop: Shop }) {
  const { t, language } = useI18n();
  const update = useUpdateShop(teamId);
  const remove = useDeleteShop(teamId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address);

  if (editing) {
    return (
      <li className="flex flex-col gap-2 py-3">
        <Input aria-label={t("Shop name")} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <Input aria-label={t("Address")} value={address} maxLength={240} placeholder={t("Address")} onChange={(e) => setAddress(e.target.value)} />
        <FormError message={update.error?.message ?? null} />
        <div className="flex gap-2">
          <Button size="sm" loading={update.isPending} disabled={!name.trim()}
            onClick={() => update.mutate({ id: shop.id, name: name.trim(), address: address.trim() }, { onSuccess: () => setEditing(false) })}>
            {t("Save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setName(shop.name); setAddress(shop.address); }}>{t("Cancel")}</Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-body">{shop.name}</p>
        <p className="text-[12px] text-muted">
          {[
            shop.address,
            t("{count} goods priced", { count: shop.product_count }),
            shop.last_visit && t("last visit {date}", { date: shortDate(shop.last_visit, language) }),
          ].filter(Boolean).join(" · ")}
        </p>
        {shop.aliases.length > 0 && (
          <p className="mt-0.5 truncate text-[12px] text-subtle">
            {t("Receipts print: {names}", { names: shop.aliases.join(", ") })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{t("Edit")}</Button>
        <Button size="sm" variant="ghost" loading={remove.isPending}
          onClick={() => {
            if (window.confirm(t("Delete {shop}? Its saved prices are forgotten; expenses stay.", { shop: shop.name }))) {
              remove.mutate(shop.id);
            }
          }}>
          {t("Delete")}
        </Button>
      </div>
    </li>
  );
}
