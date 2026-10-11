import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell, PageTitle } from "../components/Layout";
import { PriceVerdict } from "../components/PriceViz";
import { ProductLinker, type ProductLink } from "../components/ProductLinker";
import { ReceiptScanner, type ScannerCopy } from "../components/ReceiptScanner";
import { CameraIcon, ScanPanel } from "../components/ScanButton";
import { ShopMatchCard, ShopPicker } from "../components/ShopPicker";
import {
  Button, Card, Field, FormError, Input, Money, MoneyInput, Skeleton, cx,
} from "../components/ui";
import { useImportPrices, useProducts, useServerConfig, useTeam } from "../hooks/queries";
import { useScanFlow } from "../hooks/useScanFlow";
import { ApiError } from "../lib/api";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { toMajorString, toMinor } from "../lib/money";
import { formatPercent } from "../lib/price-format";
import { priceGap } from "../lib/prices";
import type { PriceScan, Product, ShopMatch } from "../lib/types";

interface Row extends ProductLink {
  key: string;
  /** As the screenshot shows it; remembered per shop so the next scan links it. */
  name: string;
  price: string;
  /** A crossed-out or old price: with it, the price is a sale. */
  regular: string;
  saleUntil: string;
}

let counter = 0;
const nextKey = () => `price-${counter++}`;

/**
 * Prices from a screenshot or photo of a shop's prices -- its app, website,
 * a leaflet, shelf tags. The model proposes goods and prices; every row is
 * checked and editable here, and only "Save" stores them, as that shop's
 * prices. Nothing is bought, so no expense is made.
 */
export default function PriceImport() {
  const { teamId = "" } = useParams();
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const team = useTeam(teamId);
  const config = useServerConfig();
  const save = useImportPrices(teamId);
  const currency = team.data?.currency ?? "RUB";
  const back = { to: `/teams/${teamId}?tab=prices`, label: team.data?.name ?? t("Back") };

  // Opened from the scan card on the Prices tab, so the scanner is already up.
  const scan = useScanFlow(true);
  const [notes, setNotes] = useState<string[]>([]);
  const [shopId, setShopId] = useState("");
  const [shopNotice, setShopNotice] = useState<ShopMatch | null>(null);
  const [observedOn, setObservedOn] = useState(todayLocal());
  const [rows, setRows] = useState<Row[]>([]);

  const productIds = useMemo(
    () => [...new Set(rows.flatMap((row) => (row.track && row.productId ? [row.productId] : [])))].sort(),
    [rows],
  );
  const linked = useProducts(teamId, { ids: productIds, limit: 200 }, productIds.length > 0);
  const productsById = useMemo(
    () => new Map<string, Product>((linked.data?.items ?? []).map((product) => [product.id, product])),
    [linked.data],
  );

  const copy: ScannerCopy = {
    title: t("Read prices from a screenshot"),
    intro: t("A screenshot of a shop's app or website, a promotion leaflet, or photos of price tags. Several images can go at once. Every price comes back editable, and nothing is saved until you check it."),
    read: t("Read the prices"),
    reading: t("Reading the prices…"),
  };

  function applyScan(result: PriceScan) {
    if (result.shop.shop_id && !shopId) setShopId(result.shop.shop_id);
    if (result.shop.shop_id || result.shop.name) setShopNotice(result.shop);
    if (result.notes) setNotes((list) => [...list, result.notes!]);
    // Prices read in another currency would be saved as the team's; say so.
    if (result.currency !== currency) {
      setNotes((list) => [...list, t("These prices looked like {currency}; they are saved in {team}.", { currency: result.currency, team: currency })]);
    }
    setRows((list) => [...list, ...result.items.map((item) => ({
      key: nextKey(),
      name: item.name,
      productId: item.product_id ?? undefined,
      productName: item.product_name ?? undefined,
      productMatch: item.product_match,
      track: true,
      price: item.price === null ? "" : toMajorString(item.price, currency),
      regular: item.regular_price === null ? "" : toMajorString(item.regular_price, currency),
      saleUntil: item.sale_until ?? "",
    }))]);
    scan.finish();
  }

  const update = (key: string, patch: Partial<Row>) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const scanUnavailable = config.data?.receipt_scanning === false;
  const included = rows.filter((row) => row.track);
  const parsed = included.map((row) => {
    const price = toMinor(row.price, currency);
    const regular = row.regular.trim() ? toMinor(row.regular, currency) : null;
    return { row, price, regular, sale: regular !== null && price !== null && regular > price };
  });

  const problems: string[] = [];
  if (!shopId) problems.push(t("Choose which shop these prices are from."));
  if (included.length === 0) problems.push(t("Keep at least one price."));
  if (parsed.some(({ price }) => price === null || price <= 0)) problems.push(t("Every kept line needs a price."));
  if (parsed.some(({ row, regular }) => row.regular.trim() && regular === null)) problems.push(t("An old price is not a number."));
  if (parsed.some(({ row, sale }) => sale && row.saleUntil && row.saleUntil < observedOn)) {
    problems.push(t("A sale cannot end before the day the prices were seen."));
  }
  const valid = problems.length === 0;

  function submit() {
    if (!valid) return;
    save.mutate(
      {
        shop_id: shopId,
        observed_on: observedOn,
        items: parsed.map(({ row, price, regular, sale }) => ({
          name: row.name.trim().slice(0, 200) || (row.productName ?? "").slice(0, 200),
          product_id: row.productId ?? null,
          product_name: row.productName?.slice(0, 200) || null,
          price: price!,
          regular_price: sale ? regular : null,
          sale_until: sale && row.saleUntil ? row.saleUntil : null,
        })),
      },
      { onSuccess: () => navigate(`/teams/${teamId}?tab=prices`) },
    );
  }

  if (team.isPending || config.isPending) {
    return (
      <AppShell back={back}>
        <Skeleton className="mb-6 h-9 w-64" />
        <Card className="h-64" />
      </AppShell>
    );
  }

  const bar = rows.length > 0 ? (
    <div className="flex flex-col gap-2">
      <FormError message={save.error instanceof ApiError ? save.error.message : null} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!valid && <p className="text-[13px] text-muted sm:order-last sm:ml-2" aria-live="polite">{problems[0]}</p>}
        <Button full className="sm:w-auto" loading={save.isPending} disabled={!valid || scan.scanning} onClick={submit}>
          {t(included.length === 1 ? "Save {count} price" : "Save {count} prices", { count: included.length })}
        </Button>
      </div>
    </div>
  ) : undefined;

  return (
    <AppShell back={back} bar={bar}>
      <PageTitle
        title={t("Prices from a screenshot")}
        subtitle={t("Saved as the shop's prices. Nothing is bought, so no expense is added.")}
      />
      <div className="flex flex-col gap-4">
        <ScanPanel
          flow={scan}
          title={t(rows.length ? "Add from screenshot" : "Read prices from a screenshot")}
          hint={t(scanUnavailable
            ? "Receipt scanning is not configured on this server."
            : "A shop's app or website, a leaflet, or price tags. Upload, drop or paste; on a phone, take a photo.")}
        >
          <ReceiptScanner<PriceScan>
            teamId={teamId}
            appendToExisting={rows.length > 0}
            path={`/teams/${teamId}/prices/scan`}
            body={{ today: todayLocal() }}
            copy={copy}
            onParsed={applyScan}
            onCancel={() => (rows.length ? scan.close() : navigate(back.to))}
          />
        </ScanPanel>

        {rows.length > 0 && (
          <div ref={scan.resultsRef} className="flex scroll-mt-[calc(var(--header-h)+env(safe-area-inset-top)+1rem)] flex-col gap-4">
            <Card className="flex flex-col gap-4 p-4 sm:p-5">
              <ShopPicker teamId={teamId} value={shopId} onChange={setShopId}
                hint={t("Required: these prices are saved for this shop.")} />
              {shopNotice && (
                <ShopMatchCard teamId={teamId} match={shopNotice} merchant={null} shopId={shopId}
                  onPick={setShopId} onDismiss={() => setShopNotice(null)} />
              )}
              <Field label={t("Seen on")} hint={t("When these prices were shown. A newer saved price is never replaced by an older one.")}>
                {(id) => <Input id={id} type="date" className="w-auto" max={todayLocal()} value={observedOn} onChange={(e) => setObservedOn(e.target.value)} />}
              </Field>
              {notes.map((note, i) => (
                <p key={i} className="rounded-control bg-surface-2 px-3 py-2 text-[12px] text-muted">{note}</p>
              ))}
            </Card>

            <Card className="flex flex-col gap-3 p-4 sm:p-5">
              <p className="text-[13px] text-muted">
                {t("Check each price. An old price makes it a sale, which ends by itself; without an end date it lasts a week.")}
              </p>
              <ul className="flex flex-col divide-y divide-line">
                {rows.map((row) => {
                  const price = toMinor(row.price, currency);
                  const regular = row.regular.trim() ? toMinor(row.regular, currency) : null;
                  const sale = regular !== null && price !== null && regular > price;
                  const product = row.productId ? productsById.get(row.productId) : undefined;
                  const here = product?.prices.find((p) => p.shop_id === shopId);
                  const gap = here?.price && price ? priceGap(price, here.price) : null;
                  return (
                    <li key={row.key} className={cx("flex flex-col gap-2.5 py-3.5 first:pt-1", !row.track && "opacity-55")}>
                      <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-2">
                        <div className="min-w-0">
                          <ProductLinker
                            teamId={teamId}
                            currency={currency}
                            lineName={row.name}
                            link={row}
                            product={product}
                            onChange={(link) => update(row.key, link)}
                          />
                          <p className="mt-0.5 truncate text-[12px] text-subtle" title={row.name}>
                            {t("As shown: {name}", { name: row.name })}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <label htmlFor={`${row.key}-price`} className="sr-only">{t("Price")}</label>
                          <MoneyInput id={`${row.key}-price`} value={row.price} placeholder="0.00" disabled={!row.track}
                            onChange={(e) => update(row.key, { price: e.target.value })} />
                        </div>
                      </div>
                      {row.track && (
                        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                          <div className="w-28">
                            <label htmlFor={`${row.key}-regular`} className="mb-1 block text-[12px] text-muted">{t("Old price")}</label>
                            <MoneyInput id={`${row.key}-regular`} value={row.regular} placeholder={t("none")}
                              onChange={(e) => update(row.key, { regular: e.target.value })} />
                          </div>
                          {sale && (
                            <div>
                              <label htmlFor={`${row.key}-until`} className="mb-1 block text-[12px] text-muted">{t("Sale until")}</label>
                              <Input id={`${row.key}-until`} type="date" className="w-auto" min={observedOn} value={row.saleUntil}
                                onChange={(e) => update(row.key, { saleUntil: e.target.value })} />
                            </div>
                          )}
                          {row.regular.trim() && regular !== null && !sale && (
                            <p className="pb-2 text-[12px] text-muted">{t("Not higher than the price, so not a sale.")}</p>
                          )}
                          <button type="button" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
                            className="ml-auto rounded-control px-2 py-2 text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-body">
                            {t("Remove")}
                          </button>
                        </div>
                      )}
                      {row.track && shopId && product && price !== null && price > 0 && (
                        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                          {here?.price != null && (
                            <span>
                              {t("Saved here")} <Money minor={here.price} currency={currency} className="text-[12px]" />
                              {gap && gap.diff !== 0 && gap.percent !== null && (
                                <span className={cx("ml-1.5", gap.diff > 0 ? "text-muted" : "text-price-low")}>
                                  {gap.diff > 0 ? "↑" : "↓"} {formatPercent(gap.percent, language)}%
                                </span>
                              )}
                            </span>
                          )}
                          <PriceVerdict paid={price} product={product} shopId={shopId} currency={currency} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!scan.scanning && (
                <Button type="button" variant="secondary" size="sm" className="self-start" onClick={scan.open}>
                  <CameraIcon />
                  {t("Add from screenshot")}
                </Button>
              )}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
