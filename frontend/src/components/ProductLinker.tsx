import { useId, useState } from "react";
import { useProducts } from "../hooks/queries";
import { useI18n } from "../lib/i18n";
import { formatMoney } from "../lib/money";
import type { Product } from "../lib/types";
import { Button, Input, cx } from "./ui";

export interface ProductLink {
  productId?: string;
  /** Name for a new product when none is linked; the model's readable name. */
  productName?: string;
  /** "model" and "name" matches are suggestions, worth a second look. */
  productMatch?: "receipt" | "model" | "name" | null;
  track: boolean;
}

export function TagIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8.6V3a.5.5 0 0 1 .5-.5h5.6l5 5a1 1 0 0 1 0 1.4l-4.2 4.2a1 1 0 0 1-1.4 0l-5.5-4.5Z" />
      <circle cx="5.5" cy="5.5" r="1" />
    </svg>
  );
}

/**
 * Which product a receipt line is, so its price joins that product's history.
 * Collapsed it is one quiet line under the item; opened it searches the
 * team's goods, starts a new one, or keeps the line out of price tracking.
 */
export function ProductLinker({
  teamId,
  currency,
  lineName,
  link,
  product,
  onChange,
}: {
  teamId: string;
  currency: string;
  lineName: string;
  link: ProductLink;
  product?: Product;
  onChange: (link: ProductLink) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const results = useProducts(teamId, { q: search.trim(), limit: 6, sort: "recent" }, open);
  const suggestedName = (link.productName || lineName).trim();

  const summary = !link.track ? (
    <span className="text-muted">{t("Price not tracked")}</span>
  ) : link.productId ? (
    <>
      <span className="truncate text-body">{product?.name ?? t("Linked product")}</span>
      {(link.productMatch === "model" || link.productMatch === "name") && (
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{t("suggested")}</span>
      )}
    </>
  ) : (
    <>
      <span className="truncate text-muted">{suggestedName || t("New product")}</span>
      <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{t("new")}</span>
    </>
  );

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setNewName(suggestedName); }}
        className={cx(
          "-mx-1 flex max-w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-[12px]",
          "transition-colors hover:bg-surface-2 active:bg-surface-2 active:duration-0 pointer-coarse:py-1.5",
        )}
      >
        <span className="shrink-0 text-subtle"><TagIcon /></span>
        {summary}
        <svg viewBox="0 0 16 16" className={cx("size-3 shrink-0 text-subtle transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-3 rounded-control border border-line bg-surface-2 p-3">
          <div>
            <label htmlFor={`${uid}-search`} className="mb-1.5 block text-[12px] text-muted">
              {t("Same product as one you already track")}
            </label>
            <Input
              id={`${uid}-search`}
              type="search"
              value={search}
              placeholder={t("Search goods")}
              enterKeyHint="search"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
            />
            <ul className="mt-2 flex flex-col">
              {results.data?.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => { onChange({ ...link, productId: item.id, productMatch: null, track: true }); setOpen(false); }}
                    className={cx(
                      "flex w-full items-baseline justify-between gap-3 rounded-control px-2 py-2 text-left text-[13px]",
                      "transition-colors hover:bg-surface active:bg-surface",
                      item.id === link.productId && "bg-surface font-medium",
                    )}
                  >
                    <span className="min-w-0 truncate text-body">{item.name}</span>
                    {item.best_price !== null && (
                      <span className="shrink-0 text-[12px] text-muted">
                        {t("from {price}", { price: formatMoney(item.best_price, currency) })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {results.data?.items.length === 0 && (
                <li className="px-2 py-2 text-[12px] text-muted">{t("Nothing matched.")}</li>
              )}
            </ul>
          </div>
          <div className="border-t border-line pt-3">
            <label htmlFor={`${uid}-new`} className="mb-1.5 block text-[12px] text-muted">
              {t("Or track it as a new product")}
            </label>
            <div className="flex gap-2">
              <Input id={`${uid}-new`} value={newName} maxLength={200}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
              <Button type="button" variant="secondary" disabled={!newName.trim()}
                onClick={() => {
                  onChange({ productId: undefined, productName: newName.trim(), productMatch: null, track: true });
                  setOpen(false);
                }}>
                {t("Use")}
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-muted">
              {t("If a product with this name exists, the line joins it.")}
            </p>
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-3">
            <Button type="button" variant="ghost" size="sm" className="-ml-2"
              onClick={() => { onChange({ ...link, track: !link.track }); setOpen(false); }}>
              {t(link.track ? "Don't track this line" : "Track this line")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="-mr-2" onClick={() => setOpen(false)}>
              {t("Close")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
