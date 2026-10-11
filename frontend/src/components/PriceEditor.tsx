import { useState } from "react";
import { useProductMutations } from "../hooks/queries";
import { todayLocal } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { toMajorString, toMinor } from "../lib/money";
import type { ProductDetail } from "../lib/types";
import { ShopPicker } from "./ShopPicker";
import { Button, Field, FormError, Input, MoneyInput } from "./ui";

/** A price is usable when left empty or written as a positive amount. */
function usable(text: string, minor: number | null): boolean {
  return !text.trim() || (minor !== null && minor > 0);
}

/**
 * Create or change what one shop charges for a product: a price seen on a
 * shelf, a correction, or a sale and when it ends. Saving replaces what is
 * stored for that shop, so an empty sale ends a running one.
 */
export function PriceEditor({
  teamId,
  product,
  currency,
  shopId: fixedShopId,
  onDone,
}: {
  teamId: string;
  product: ProductDetail;
  currency: string;
  /** Editing this shop's price; left out, the editor asks which shop. */
  shopId?: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { setPrice, forgetPrice } = useProductMutations(teamId, product.id);
  const [shopId, setShopId] = useState(fixedShopId ?? "");
  const row = product.prices.find((r) => r.shop_id === shopId);
  const [regular, setRegular] = useState(row?.regular_price ? toMajorString(row.regular_price, currency) : "");
  const [sale, setSale] = useState(row?.on_sale && row.sale_price ? toMajorString(row.sale_price, currency) : "");
  const [until, setUntil] = useState(row?.on_sale ? row.sale_until ?? "" : "");
  const today = todayLocal();

  function choose(id: string) {
    setShopId(id);
    const chosen = product.prices.find((r) => r.shop_id === id);
    setRegular(chosen?.regular_price ? toMajorString(chosen.regular_price, currency) : "");
    setSale(chosen?.on_sale && chosen.sale_price ? toMajorString(chosen.sale_price, currency) : "");
    setUntil(chosen?.on_sale ? chosen.sale_until ?? "" : "");
    setPrice.reset();
  }

  const regularMinor = regular.trim() ? toMinor(regular, currency) : null;
  const saleMinor = sale.trim() ? toMinor(sale, currency) : null;
  const valid = Boolean(shopId) && usable(regular, regularMinor) && usable(sale, saleMinor)
    && Boolean(regularMinor || saleMinor);

  return (
    <div className="flex flex-col gap-4 rounded-control border border-line bg-surface-2 p-3 sm:p-4"
      role="group" aria-label={row ? t("Edit price at {shop}", { shop: row.shop_name }) : t("Add a price")}>
      {fixedShopId ? (
        <p className="text-sm font-medium text-body">{t("Price at {shop}", { shop: row?.shop_name ?? "" })}</p>
      ) : (
        <ShopPicker teamId={teamId} value={shopId} onChange={choose}
          hint={row ? t("This shop already has a price; saving changes it.") : undefined} />
      )}
      {shopId && (
        <>
          <div className="grid gap-3 min-[420px]:grid-cols-2">
            <Field label={t("Regular price")} hint={t("Per piece, or per kilogram")}>
              {(id) => <MoneyInput id={id} value={regular} placeholder="0.00" onChange={(e) => setRegular(e.target.value)} />}
            </Field>
            <Field label={t("Sale price")} hint={t("Optional")}>
              {(id) => <MoneyInput id={id} value={sale} placeholder="0.00" onChange={(e) => setSale(e.target.value)} />}
            </Field>
          </div>
          {sale.trim() && (
            <Field label={t("Sale ends")} hint={t("Empty means a week from today.")}>
              {(id) => <Input id={id} type="date" className="w-auto" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />}
            </Field>
          )}
          <FormError message={setPrice.error?.message ?? forgetPrice.error?.message ?? null} />
          <div className="flex flex-wrap gap-2">
            <Button loading={setPrice.isPending} disabled={!valid}
              onClick={() => setPrice.mutate({
                shopId, regular_price: regularMinor, sale_price: saleMinor,
                sale_until: saleMinor ? until || null : null, observed_on: today,
              }, { onSuccess: onDone })}>
              {t("Save price")}
            </Button>
            <Button variant="ghost" onClick={onDone}>{t("Cancel")}</Button>
            {row && (row.price !== null || row.regular_price !== null) && (
              <Button variant="ghost" className="sm:ml-auto" loading={forgetPrice.isPending}
                onClick={() => forgetPrice.mutate(shopId, { onSuccess: onDone })}>
                {t("Forget this shop's price")}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
