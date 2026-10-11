"""Shops, goods, and what the team pays for them.

Two kinds of price live here, and keeping them apart is the whole design:

- **Paid** -- every saved receipt line linked to a product, at the expense's
  shop, is an observation of what that product cost there on that day. These
  are never stored twice: they *are* the expense lines, so editing or deleting
  an expense corrects the history with no extra bookkeeping.
- **Charged** -- ``ShopPrice``, the price the team accepts as what a shop asks
  today. The first purchase sets it. After that a different price on a receipt
  only replaces it when someone says so, because it may be a misread, a one-off,
  or a sale.

A sale is temporary by nature, so it never overwrites the regular price: it sits
beside it with an end date, counts as the shop's price while it runs, and the
regular price is back by itself once it ends.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ExpenseItem, Product, ProductAlias, Shop, ShopPrice

# How long a sale is assumed to last when nobody says. Chain promotions in
# Russia mostly run one or two weeks; a short guess errs towards the regular
# price coming back rather than a stale bargain being quoted.
SALE_DAYS = 7

# Legal-entity words that a receipt prints around a shop's name.
_LEGAL_FORMS = frozenset(
    {"ооо", "оао", "зао", "пао", "ао", "ип", "нко", "llc", "ltd", "inc", "gmbh", "co", "corp"}
)
_WORD = re.compile(r"[^\W_]+")  # letters and digits, in any script


def name_key(text: str) -> str:
    """The comparison form of a name: case, punctuation and "ё" no longer matter.

    Computed in Python rather than with SQL ``lower()``, which folds only ASCII
    in SQLite -- "Молоко" and "молоко" would otherwise be two products.
    """
    folded = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    return " ".join(_WORD.findall(folded))[:200]


def shop_key(text: str) -> str:
    """``name_key`` without legal forms: 'ООО "Агроторг"' compares as 'агроторг'.

    Taken over the first 120 characters, the length an alias is stored at, so a
    long printed name still matches the alias it was saved as.
    """
    return " ".join(w for w in name_key(text.strip()[:120]).split() if w not in _LEGAL_FORMS)


def paid_per_unit(total: int, quantity: Decimal) -> int:
    """What one unit cost on a receipt line, after any discount on that line.

    Derived from the line total rather than the printed unit price: on a
    discounted line the printed price is often the pre-discount one.
    """
    if quantity <= 0:
        return total
    return int((Decimal(total) / quantity).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def sale_running(price: ShopPrice, on: date) -> bool:
    return (
        price.sale_price is not None
        and price.sale_on is not None
        and price.sale_on <= on
        and (price.sale_until is None or on <= price.sale_until)
    )


def price_now(price: ShopPrice, today: date) -> int | None:
    """What this shop charges today: a running sale, else the regular price."""
    return price.sale_price if sale_running(price, today) else price.regular_price


# ------------------------------------------------------------------- matching


def find_shop(shops: Iterable[Shop], *printed: str | None) -> Shop | None:
    """The shop whose name or a remembered alias matches any printed name."""
    keys = {shop_key(text) for text in printed if text}
    keys.discard("")
    if not keys:
        return None
    for shop in shops:
        if shop.key in keys or keys & {shop_key(alias) for alias in shop.aliases}:
            return shop
    return None


def remember_shop_alias(shop: Shop, printed: str | None) -> None:
    """Teach the shop another way receipts print its name."""
    if not printed or not printed.strip():
        return
    key = shop_key(printed)
    if not key or key == shop.key or key in {shop_key(a) for a in shop.aliases}:
        return
    # Reassigned, not appended: a JSON column only notices a new list.
    shop.aliases = [*shop.aliases, printed.strip()[:120]][-20:]


def alias_products(
    session: Session, shop_id: uuid.UUID, names: Iterable[str]
) -> dict[str, uuid.UUID]:
    """Line name key -> product, for lines this shop's receipts have printed before."""
    keys = {name_key(name) for name in names} - {""}
    if not keys:
        return {}
    rows = session.execute(
        select(ProductAlias.key, ProductAlias.product_id).where(
            ProductAlias.shop_id == shop_id, ProductAlias.key.in_(keys)
        )
    ).all()
    return dict(rows)


def products_by_key(
    session: Session, team_id: uuid.UUID, names: Iterable[str]
) -> dict[str, uuid.UUID]:
    keys = {name_key(name) for name in names} - {""}
    if not keys:
        return {}
    rows = session.execute(
        select(Product.key, Product.id).where(Product.team_id == team_id, Product.key.in_(keys))
    ).all()
    return dict(rows)


def product_name_for(shown: str, readable: str | None) -> str:
    """The name for a new product: the readable one when it has any letters or
    digits, else the name as printed. A readable name of "-" or "..." would
    otherwise give an empty key, and every such line would share one product."""
    readable = (readable or "").strip()
    return readable[:200] if name_key(readable) else shown.strip()[:200]


def link_products(
    session: Session,
    team_id: uuid.UUID,
    shop_id: uuid.UUID,
    lines: list[tuple[str, uuid.UUID | None, str | None]],
) -> list[uuid.UUID]:
    """The product for each (name as printed, product chosen, readable name).

    A chosen product wins; otherwise how this shop printed the name before,
    then a product of the same name, and failing all three a new product.
    Each printed name is remembered for the shop, so the latest link wins and
    re-linking a line by hand corrects it for next time. Lines whose printed
    name has no letters or digits must be filtered out by the caller.
    """
    keys = [name_key(shown) for shown, _, _ in lines]
    wanted = [product_name_for(shown, readable) for shown, _, readable in lines]
    by_name = products_by_key(session, team_id, wanted)
    aliases = {
        alias.key: alias
        for alias in session.scalars(
            select(ProductAlias).where(ProductAlias.shop_id == shop_id, ProductAlias.key.in_(keys))
        )
    }
    linked: list[uuid.UUID] = []
    for (shown, chosen, _), key, name in zip(lines, keys, wanted, strict=True):
        product_id = chosen or (aliases[key].product_id if key in aliases else None)
        product_id = product_id or by_name.get(name_key(name))
        if product_id is None:
            product = get_or_create_product(session, team_id, name)
            product_id = by_name[product.key] = product.id
        alias = aliases.get(key)
        if alias is None:
            aliases[key] = alias = ProductAlias(shop_id=shop_id, key=key)
            session.add(alias)
        alias.product_id = product_id
        alias.name = shown[:200]
        linked.append(product_id)
    return linked


def get_or_create_product(session: Session, team_id: uuid.UUID, name: str) -> Product:
    key = name_key(name)
    product = session.scalar(select(Product).where(Product.team_id == team_id, Product.key == key))
    if product is None:
        product = Product(id=uuid.uuid4(), team_id=team_id, name=name.strip()[:200], key=key)
        session.add(product)
        session.flush()
    return product


# --------------------------------------------------------------- price review


@dataclass(slots=True)
class Observation:
    """One receipt line's evidence about a price."""

    product_id: uuid.UUID
    shop_id: uuid.UUID
    observed_on: date
    price: int
    on_sale: bool
    regular_price: int | None = None


def needs_review(current: ShopPrice, seen: Observation) -> bool:
    """Whether a receipt price should ask "update the saved price?".

    It does not when it agrees with the saved price (or with a sale running
    that day), when someone already answered for this very price on this day,
    or when the receipt is older than what is saved -- an old receipt entered
    late must not quietly roll a price back.
    """
    if seen.price == current.regular_price and not seen.on_sale:
        return False
    if sale_running(current, seen.observed_on) and seen.price == current.sale_price:
        return False
    if current.reviewed_on is not None and (
        seen.observed_on < current.reviewed_on
        or (seen.observed_on == current.reviewed_on and seen.price == current.reviewed_price)
    ):
        return False
    newest = max((d for d in (current.regular_on, current.sale_on) if d), default=None)
    return newest is None or seen.observed_on >= newest


def _mark_reviewed(current: ShopPrice, on: date, price: int) -> None:
    if current.reviewed_on is None or on >= current.reviewed_on:
        current.reviewed_on = on
        current.reviewed_price = price


def set_regular(current: ShopPrice, price: int, on: date) -> None:
    if current.regular_on is None or on >= current.regular_on:
        current.regular_price = price
        current.regular_on = on
    # Paying the regular price after a sale began means the sale is over.
    if current.sale_on is not None and current.sale_on <= on:
        clear_sale(current)


def set_sale(
    current: ShopPrice,
    price: int,
    on: date,
    until: date | None = None,
    regular_price: int | None = None,
) -> None:
    current.sale_price = price
    current.sale_on = on
    current.sale_until = until if until is not None else on + timedelta(days=SALE_DAYS)
    # A receipt that prints the undiscounted price is the best evidence of it.
    if regular_price is not None and regular_price > price:
        if current.regular_on is None or on >= current.regular_on:
            current.regular_price = regular_price
            current.regular_on = on


def clear_sale(current: ShopPrice) -> None:
    current.sale_price = None
    current.sale_on = None
    current.sale_until = None


Decision = Literal["regular", "sale", "keep"]


def decide(
    current: ShopPrice,
    seen: Observation,
    decision: Decision,
    sale_until: date | None = None,
) -> None:
    """Apply someone's answer to "this receipt has a new price -- update it?"."""
    if decision == "regular":
        set_regular(current, seen.price, seen.observed_on)
    elif decision == "sale":
        set_sale(current, seen.price, seen.observed_on, sale_until, seen.regular_price)
    _mark_reviewed(current, seen.observed_on, seen.price)


def set_listed(
    current: ShopPrice,
    price: int,
    on: date,
    regular_price: int | None = None,
    sale_until: date | None = None,
) -> None:
    """A price someone read off a shop's app, site or shelf and confirmed.

    A higher old price beside it makes it a sale; without one it is the
    regular price, which also ends a sale that began before it. Confirmed by
    hand, so it counts as answered and no receipt from that day asks again.
    """
    if regular_price is not None and regular_price > price:
        set_sale(current, price, on, sale_until, regular_price)
    else:
        set_regular(current, price, on)
    _mark_reviewed(current, on, price)


def first_sighting(product_id: uuid.UUID, seen: Observation) -> ShopPrice:
    """The first price seen at a shop is accepted as is; there is nothing to ask."""
    current = ShopPrice(product_id=product_id, shop_id=seen.shop_id)
    if seen.on_sale:
        set_sale(current, seen.price, seen.observed_on, regular_price=seen.regular_price)
    else:
        set_regular(current, seen.price, seen.observed_on)
    _mark_reviewed(current, seen.observed_on, seen.price)
    return current


def record_observations(session: Session, seen: list[Observation]) -> list[Observation]:
    """Fold receipt prices into the saved ones; return those that need a decision.

    Processed in order, so a receipt with the same good on two lines asks at
    most once -- the first line sets the price the second is compared with.
    """
    if not seen:
        return []
    pairs = {(o.product_id, o.shop_id) for o in seen}
    saved = {
        (p.product_id, p.shop_id): p
        for p in session.scalars(
            select(ShopPrice).where(
                ShopPrice.product_id.in_({product for product, _ in pairs}),
                ShopPrice.shop_id.in_({shop for _, shop in pairs}),
            )
        )
    }
    pending: list[Observation] = []
    for observation in seen:
        pair = (observation.product_id, observation.shop_id)
        current = saved.get(pair)
        if current is None:
            current = first_sighting(observation.product_id, observation)
            session.add(current)
            saved[pair] = current
        elif needs_review(current, observation):
            if not any(
                (p.product_id, p.shop_id, p.price) == (*pair, observation.price) for p in pending
            ):
                pending.append(observation)
        elif observation.price == current.regular_price and (
            current.regular_on is None or observation.observed_on > current.regular_on
        ):
            # Same price seen again: it is still current as of this receipt.
            current.regular_on = observation.observed_on
    return pending


def observation_for(item: ExpenseItem, shop_id: uuid.UUID, on: date) -> Observation | None:
    if item.product_id is None or item.total <= 0:
        return None
    return Observation(
        product_id=item.product_id,
        shop_id=shop_id,
        observed_on=on,
        price=paid_per_unit(item.total, item.quantity),
        on_sale=item.on_sale,
        regular_price=item.regular_unit_price,
    )


# -------------------------------------------------------------------- savings

# How far either side of a purchase a price still counts as "usual then".
# Wide enough to find a price at most shops; narrow enough that last year's
# prices do not turn inflation into savings.
USUAL_WINDOW = timedelta(days=90)


@dataclass(slots=True)
class Purchase:
    """A tracked receipt line, in the shape the savings sum needs."""

    expense_id: uuid.UUID
    product_id: uuid.UUID
    shop_id: uuid.UUID
    spent_at: date
    total: int
    quantity: Decimal
    on_sale: bool
    regular_price: int | None


@dataclass(slots=True)
class PriceSeen:
    """A regular (not sale) price for a product at a shop on a day."""

    shop_id: uuid.UUID
    on: date
    price: int


def usual_price(seen: list[PriceSeen], on: date) -> Decimal | None:
    """The usual price of a good around a day: each shop's regular price
    nearest that day (within the window), averaged over shops."""
    nearest: dict[uuid.UUID, PriceSeen] = {}
    for price in seen:
        gap = abs(price.on - on)
        if gap > USUAL_WINDOW:
            continue
        best = nearest.get(price.shop_id)
        if best is None or gap < abs(best.on - on):
            nearest[price.shop_id] = price
    if not nearest:
        return None
    return Decimal(sum(p.price for p in nearest.values())) / len(nearest)


def regular_prices(
    purchases: list[Purchase], saved: list[ShopPrice]
) -> dict[uuid.UUID, list[PriceSeen]]:
    """Every regular price known per product: paid at full price, printed as
    the usual price on a discounted line, or confirmed for a shop."""
    seen: dict[uuid.UUID, list[PriceSeen]] = {}
    for line in purchases:
        if not line.on_sale:
            price = paid_per_unit(line.total, line.quantity)
        elif line.regular_price is not None:
            price = line.regular_price
        else:
            continue
        seen.setdefault(line.product_id, []).append(PriceSeen(line.shop_id, line.spent_at, price))
    for current in saved:
        if current.regular_price is not None and current.regular_on is not None:
            seen.setdefault(current.product_id, []).append(
                PriceSeen(current.shop_id, current.regular_on, current.regular_price)
            )
    return seen


def saved_on(purchase: Purchase, seen: list[PriceSeen]) -> int | None:
    """What a purchase saved against the usual price then; negative if it cost
    more. None when no usual price is known to compare with.

    Buying at full price in the only shop you know saves nothing, by design:
    a saving needs a sale or a dearer shop to be real.
    """
    usual = usual_price(seen, purchase.spent_at)
    if usual is None:
        return None
    expected = (usual * purchase.quantity if purchase.quantity > 0 else usual).quantize(
        Decimal(1), rounding=ROUND_HALF_UP
    )
    return int(expected) - purchase.total
