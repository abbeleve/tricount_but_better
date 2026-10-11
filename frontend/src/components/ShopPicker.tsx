import { useState } from "react";
import { useAddShopAlias, useCreateShop, useShops } from "../hooks/queries";
import { useI18n } from "../lib/i18n";
import type { Shop, ShopMatch } from "../lib/types";
import { Button, Field, FormError, Input, Select } from "./ui";

/** Also used inside expense forms, so its actions never submit the parent form. */
export function ShopCreator({
  teamId,
  initialName = "",
  initialAddress = "",
  alias,
  onCreated,
  onCancel,
}: {
  teamId: string;
  initialName?: string;
  initialAddress?: string;
  /** How a receipt printed the shop, remembered so the next scan matches it. */
  alias?: string | null;
  onCreated?: (shop: Shop) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const create = useCreateShop(teamId);
  const [name, setName] = useState(initialName);
  const [address, setAddress] = useState(initialAddress);

  function submit() {
    if (!name.trim() || create.isPending) return;
    create.mutate(
      { name: name.trim(), address: address.trim(), alias: alias || null },
      {
        onSuccess: (shop) => {
          setName("");
          setAddress("");
          onCreated?.(shop);
        },
      },
    );
  }

  return (
    <div
      role="group"
      aria-label={t("New shop")}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      <Field label={t("Shop name")}>
        {(id) => (
          <Input id={id} value={name} maxLength={120} disabled={create.isPending} autoCapitalize="words"
            onChange={(event) => { setName(event.target.value); create.reset(); }}
            placeholder={t("e.g. Pyaterochka")} />
        )}
      </Field>
      <Field label={t("Address")} hint={t("Optional. Useful when you go to two branches of one chain.")}>
        {(id) => (
          <Input id={id} value={address} maxLength={240} disabled={create.isPending}
            onChange={(event) => setAddress(event.target.value)} />
        )}
      </Field>
      <FormError message={create.error ? create.error.message || t("Could not create this shop.") : null} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" loading={create.isPending} disabled={!name.trim()} onClick={submit}>
          {t("Add shop")}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={create.isPending} onClick={onCancel}>
            {t("Cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ShopPicker({
  teamId,
  value,
  onChange,
  hint,
}: {
  teamId: string;
  value: string;
  onChange: (shopId: string) => void;
  hint?: string;
}) {
  const { t } = useI18n();
  const shops = useShops(teamId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Field label={t("Where?")} hint={hint}>
        {(id) => (
          <Select id={id} value={value} disabled={shops.isPending || shops.isError}
            onChange={(event) => onChange(event.target.value)}>
            <option value="">{t("No shop")}</option>
            {shops.data?.map((shop) => (
              <option key={shop.id} value={shop.id}>
                {shop.name}{shop.address ? ` · ${shop.address}` : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {shops.isError && <FormError message={t("Could not load shops.")} />}
      {creating ? (
        <div className="rounded-control border border-line bg-surface-2 p-3">
          <ShopCreator teamId={teamId}
            onCreated={(shop) => { onChange(shop.id); setCreating(false); }}
            onCancel={() => setCreating(false)} />
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setCreating(true)}>
          {t("New shop")}
        </Button>
      )}
    </div>
  );
}

/**
 * After a scan: which shop the receipt is from. A match is stated so it can be
 * checked; an unknown shop is offered as a new one, named the way customers
 * know it, or tied to an existing shop -- either way the printed name is
 * remembered, so the next receipt from there matches by itself.
 */
export function ShopMatchCard({
  teamId,
  match,
  merchant,
  shopId,
  onPick,
  onDismiss,
}: {
  teamId: string;
  match: ShopMatch;
  merchant: string | null;
  shopId: string;
  onPick: (shopId: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const shops = useShops(teamId);
  const addAlias = useAddShopAlias(teamId);
  const [creating, setCreating] = useState(false);
  const printed = merchant || match.name;
  const matched = shops.data?.find((shop) => shop.id === match.shop_id);

  if (matched) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-control bg-surface-2 px-3 py-2.5 text-[13px]" role="status">
        <p className="text-body">
          {t(match.matched_by === "model" ? "Looks like {shop}, recognised from the receipt." : "From {shop}, matched by the name on the receipt.", { shop: matched.name })}
          {shopId !== matched.id && <> {t("You chose another shop.")}</>}
        </p>
        <Button type="button" variant="ghost" size="sm" className="-my-1 -mr-2" onClick={onDismiss}>{t("OK")}</Button>
      </div>
    );
  }
  // A matched shop that is still loading is not a new one.
  if (match.shop_id && !shops.data) return null;
  if (!match.name && !merchant) return null;

  return (
    <div className="rounded-control border border-line bg-surface-2 p-3" role="group" aria-label={t("Shop on this receipt")}>
      <p className="text-sm font-medium text-body">{t("New shop on this receipt")}</p>
      <p className="mt-0.5 text-[13px] text-muted">
        {t("“{name}” is not one of your shops yet. Add it, so its prices are remembered and the next receipt from there is recognised.", { name: match.name ?? merchant ?? "" })}
      </p>
      {creating ? (
        <div className="mt-3">
          <ShopCreator teamId={teamId} initialName={match.name ?? merchant ?? ""} initialAddress={match.address ?? ""}
            alias={printed} onCreated={(shop) => { onPick(shop.id); onDismiss(); }} onCancel={() => setCreating(false)} />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => setCreating(true)}>
              {t("Add “{name}”", { name: match.name ?? merchant ?? "" })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>{t("Not now")}</Button>
          </div>
          {shops.data && shops.data.length > 0 && (
            <Field label={t("Or it is one of yours")} hint={t("Next time a receipt prints “{name}”, it will be matched to that shop.", { name: printed ?? "" })}>
              {(id) => (
                <Select id={id} value="" disabled={addAlias.isPending}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    if (!chosen) return;
                    onPick(chosen);
                    if (printed) addAlias.mutate({ id: chosen, alias: printed }, { onSuccess: onDismiss });
                    else onDismiss();
                  }}>
                  <option value="">{t("Choose a shop")}</option>
                  {shops.data.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
                </Select>
              )}
            </Field>
          )}
          <FormError message={addAlias.error?.message ?? null} />
        </div>
      )}
    </div>
  );
}
