"""Goods the team buys and what they cost in each shop."""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..catalog import (
    Observation,
    Purchase,
    decide,
    first_sighting,
    name_key,
    needs_review,
    paid_per_unit,
    price_now,
    regular_prices,
    sale_running,
    saved_on,
    set_sale,
)
from ..deps import DbSession, Membership, TeamDep
from ..models import Expense, ExpenseItem, Product, ProductAlias, Shop, ShopPrice
from ..schemas import (
    PriceChangeOut,
    PricePointOut,
    PriceReviewIn,
    ProductAliasOut,
    ProductCreate,
    ProductDetailOut,
    ProductListOut,
    ProductMerge,
    ProductOut,
    ProductUpdate,
    SavingsDayOut,
    SavingsOut,
    SavingsProductOut,
    ShopPriceIn,
    ShopPriceOut,
)

router = APIRouter(prefix="/teams/{team_id}", tags=["goods"])

_TAKEN = "a product with that name already exists"


@dataclass(slots=True)
class _Line:
    expense_id: uuid.UUID
    product_id: uuid.UUID
    shop_id: uuid.UUID | None
    spent_at: date
    price: int
    quantity: Decimal
    on_sale: bool
    regular_price: int | None


def _lines(session: Session, team_id: uuid.UUID, ids: list[uuid.UUID]) -> list[_Line]:
    """Every purchase of these products, oldest first."""
    rows = session.execute(
        select(
            ExpenseItem.expense_id,
            ExpenseItem.product_id,
            Expense.shop_id,
            Expense.spent_at,
            ExpenseItem.total,
            ExpenseItem.quantity,
            ExpenseItem.on_sale,
            ExpenseItem.regular_unit_price,
        )
        .join(Expense, Expense.id == ExpenseItem.expense_id)
        .where(Expense.team_id == team_id, ExpenseItem.product_id.in_(ids))
        .order_by(Expense.spent_at, Expense.created_at, ExpenseItem.position)
    ).all()
    return [
        _Line(
            expense_id=expense_id,
            product_id=product_id,
            shop_id=shop_id,
            spent_at=spent_at,
            price=paid_per_unit(total, quantity),
            quantity=quantity,
            on_sale=on_sale,
            regular_price=regular,
        )
        for expense_id, product_id, shop_id, spent_at, total, quantity, on_sale, regular in rows
    ]


def _change(
    product: Product, shop: Shop, current: ShopPrice | None, seen: Observation
) -> PriceChangeOut:
    running = current is not None and sale_running(current, seen.observed_on)
    return PriceChangeOut(
        product_id=product.id,
        product_name=product.name,
        shop_id=shop.id,
        shop_name=shop.name,
        observed_on=seen.observed_on,
        price=seen.price,
        on_sale=seen.on_sale,
        regular_price=seen.regular_price,
        saved_price=None if current is None else price_now(current, seen.observed_on),
        saved_on_sale=running,
    )


def build_products(
    session: Session,
    team_id: uuid.UUID,
    products: list[Product],
    today: date,
    detail: bool = False,
) -> list[ProductOut] | list[ProductDetailOut]:
    """Each product's price in every shop, its last purchase there, and what awaits review."""
    ids = [product.id for product in products]
    shops = {shop.id: shop for shop in session.scalars(select(Shop).where(Shop.team_id == team_id))}
    saved: dict[uuid.UUID, dict[uuid.UUID, ShopPrice]] = defaultdict(dict)
    for price in session.scalars(select(ShopPrice).where(ShopPrice.product_id.in_(ids))):
        saved[price.product_id][price.shop_id] = price
    lines: dict[uuid.UUID, list[_Line]] = defaultdict(list)
    for line in _lines(session, team_id, ids):
        lines[line.product_id].append(line)

    out: list = []
    for product in products:
        own = lines[product.id]
        latest: dict[uuid.UUID, _Line] = {}
        for line in own:
            if line.shop_id is not None:
                latest[line.shop_id] = line  # oldest first, so the last one wins
        rows: list[ShopPriceOut] = []
        pending: list[PriceChangeOut] = []
        for shop_id in saved[product.id].keys() | latest.keys():
            shop = shops.get(shop_id)
            if shop is None:
                continue
            current = saved[product.id].get(shop_id)
            last = latest.get(shop_id)
            if current is not None and last is not None:
                seen = Observation(
                    product_id=product.id,
                    shop_id=shop_id,
                    observed_on=last.spent_at,
                    price=last.price,
                    on_sale=last.on_sale,
                    regular_price=last.regular_price,
                )
                if needs_review(current, seen):
                    pending.append(_change(product, shop, current, seen))
            rows.append(
                ShopPriceOut(
                    shop_id=shop_id,
                    shop_name=shop.name,
                    price=None if current is None else price_now(current, today),
                    regular_price=None if current is None else current.regular_price,
                    regular_on=None if current is None else current.regular_on,
                    sale_price=None if current is None else current.sale_price,
                    sale_on=None if current is None else current.sale_on,
                    sale_until=None if current is None else current.sale_until,
                    on_sale=current is not None and sale_running(current, today),
                    last_paid=None if last is None else last.price,
                    last_paid_on=None if last is None else last.spent_at,
                    last_paid_on_sale=last is not None and last.on_sale,
                )
            )
        rows.sort(key=lambda r: (r.price is None, r.price or 0, r.shop_name.casefold()))
        best = rows[0] if rows and rows[0].price is not None else None
        fields = dict(
            id=product.id,
            name=product.name,
            prices=rows,
            best_price=best.price if best else None,
            best_shop_id=best.shop_id if best else None,
            last_bought_on=own[-1].spent_at if own else None,
            purchase_count=len(own),
            pending=pending,
        )
        if not detail:
            out.append(ProductOut(**fields))
            continue
        aliases = session.scalars(
            select(ProductAlias).where(ProductAlias.product_id == product.id)
        ).all()
        out.append(
            ProductDetailOut(
                **fields,
                history=[
                    PricePointOut(
                        expense_id=line.expense_id,
                        shop_id=line.shop_id if line.shop_id in shops else None,
                        shop_name=shops[line.shop_id].name if line.shop_id in shops else None,
                        spent_at=line.spent_at,
                        price=line.price,
                        quantity=line.quantity,
                        on_sale=line.on_sale,
                    )
                    for line in own
                ],
                aliases=[
                    ProductAliasOut(
                        shop_id=alias.shop_id, shop_name=shops[alias.shop_id].name, name=alias.name
                    )
                    for alias in aliases
                    if alias.shop_id in shops
                ],
            )
        )
    return out


def price_changes(
    session: Session, team_id: uuid.UUID, seen: Iterable[Observation]
) -> list[PriceChangeOut]:
    """Describe receipt prices awaiting a decision, against what is saved now."""
    seen = list(seen)
    if not seen:
        return []
    products = {
        p.id: p
        for p in session.scalars(
            select(Product).where(Product.id.in_({o.product_id for o in seen}))
        )
    }
    shops = {s.id: s for s in session.scalars(select(Shop).where(Shop.team_id == team_id))}
    saved = {
        (p.product_id, p.shop_id): p
        for p in session.scalars(select(ShopPrice).where(ShopPrice.product_id.in_(products.keys())))
    }
    return [
        _change(products[o.product_id], shops[o.shop_id], saved.get((o.product_id, o.shop_id)), o)
        for o in seen
    ]


def _get(session: Session, team_id: uuid.UUID, product_id: uuid.UUID) -> Product:
    product = session.get(Product, product_id)
    if product is None or product.team_id != team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "product not found")
    return product


def _shop(session: Session, team_id: uuid.UUID, shop_id: uuid.UUID) -> Shop:
    shop = session.get(Shop, shop_id)
    if shop is None or shop.team_id != team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "shop not found")
    return shop


def _key(name: str) -> str:
    key = name_key(name)
    if not key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "a product needs a name")
    return key


def _detail(session: Session, product: Product) -> ProductDetailOut:
    return build_products(session, product.team_id, [product], date.today(), detail=True)[0]


ProductFilter = Literal["all", "compared", "sale", "changed"]
ProductSort = Literal["recent", "name", "spread"]


@router.get("/products", response_model=ProductListOut)
def list_products(
    membership: Membership,
    session: DbSession,
    q: str | None = Query(default=None, max_length=120),
    ids: Annotated[list[uuid.UUID] | None, Query(max_length=200)] = None,
    shop_id: uuid.UUID | None = None,
    filter: ProductFilter = "all",
    sort: ProductSort = "recent",
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> ProductListOut:
    """Search by any word of a product's name or of how a receipt printed it.

    ``compared`` keeps goods priced in two or more shops, ``sale`` those on sale
    somewhere today, ``changed`` those with a receipt price awaiting a decision.
    ``spread`` sorts by how much the shop choice matters: the gap between the
    cheapest and the dearest shop.
    """
    team_id = membership.team_id
    query = select(Product).where(Product.team_id == team_id)
    for word in name_key(q or "").split():
        query = query.where(
            or_(
                Product.key.contains(word, autoescape=True),
                Product.id.in_(
                    select(ProductAlias.product_id).where(
                        ProductAlias.key.contains(word, autoescape=True)
                    )
                ),
            )
        )
    if ids:
        query = query.where(Product.id.in_(ids))
    if shop_id is not None:
        query = query.where(
            Product.id.in_(select(ShopPrice.product_id).where(ShopPrice.shop_id == shop_id))
        )
    products = list(session.scalars(query))
    views = build_products(session, team_id, products, date.today())

    if filter == "compared":
        views = [v for v in views if sum(r.price is not None for r in v.prices) >= 2]
    elif filter == "sale":
        views = [v for v in views if any(r.on_sale for r in v.prices)]
    elif filter == "changed":
        views = [v for v in views if v.pending]

    def spread(view: ProductOut) -> int:
        known = [r.price for r in view.prices if r.price is not None]
        return max(known) - min(known) if len(known) >= 2 else -1

    views.sort(key=lambda v: v.name.casefold())
    if sort == "recent":
        views.sort(key=lambda v: v.last_bought_on or date.min, reverse=True)
    elif sort == "spread":
        views.sort(key=spread, reverse=True)
    return ProductListOut(items=views[offset : offset + limit], total_count=len(views))


@router.post("/products", response_model=ProductDetailOut, status_code=status.HTTP_201_CREATED)
def create_product(
    payload: ProductCreate, membership: Membership, session: DbSession
) -> ProductDetailOut:
    product = Product(team_id=membership.team_id, name=payload.name, key=_key(payload.name))
    session.add(product)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _TAKEN) from exc
    return _detail(session, product)


@router.get("/products/{product_id}", response_model=ProductDetailOut)
def get_product(
    product_id: uuid.UUID, membership: Membership, session: DbSession
) -> ProductDetailOut:
    return _detail(session, _get(session, membership.team_id, product_id))


@router.patch("/products/{product_id}", response_model=ProductDetailOut)
def rename_product(
    product_id: uuid.UUID, payload: ProductUpdate, membership: Membership, session: DbSession
) -> ProductDetailOut:
    product = _get(session, membership.team_id, product_id)
    product.name = payload.name
    product.key = _key(payload.name)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _TAKEN) from exc
    return _detail(session, product)


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    """Stop tracking a good. Its expense lines stay, unlinked."""
    session.delete(_get(session, membership.team_id, product_id))
    session.commit()


@router.post("/products/{product_id}/merge", response_model=ProductDetailOut)
def merge_product(
    product_id: uuid.UUID, payload: ProductMerge, membership: Membership, session: DbSession
) -> ProductDetailOut:
    """Fold a duplicate into another product: one good, bought in two shops.

    Purchases and receipt names move across. Where both had a price for the
    same shop, the more recently confirmed one is kept.
    """
    source = _get(session, membership.team_id, product_id)
    target = _get(session, membership.team_id, payload.into_id)
    if source.id == target.id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "a product cannot merge into itself"
        )

    session.execute(
        update(ExpenseItem).where(ExpenseItem.product_id == source.id).values(product_id=target.id)
    )
    for alias in list(source.aliases):
        alias.product = target
    kept = {price.shop_id: price for price in target.prices}

    def confirmed(price: ShopPrice) -> date:
        return max((d for d in (price.regular_on, price.sale_on) if d), default=date.min)

    for price in list(source.prices):
        other = kept.get(price.shop_id)
        if other is not None and confirmed(other) >= confirmed(price):
            continue
        if other is not None:
            target.prices.remove(other)
            session.flush()  # the (product, shop) pair is unique: drop before moving
        price.product = target
    session.flush()
    session.delete(source)
    session.commit()
    session.refresh(target)
    return _detail(session, target)


@router.put("/products/{product_id}/prices/{shop_id}", response_model=ProductDetailOut)
def set_price(
    product_id: uuid.UUID,
    shop_id: uuid.UUID,
    payload: ShopPriceIn,
    membership: Membership,
    session: DbSession,
) -> ProductDetailOut:
    """Set what a shop charges by hand; leaving the sale out ends one."""
    product = _get(session, membership.team_id, product_id)
    shop = _shop(session, membership.team_id, shop_id)
    current = session.scalar(
        select(ShopPrice).where(
            and_(ShopPrice.product_id == product.id, ShopPrice.shop_id == shop.id)
        )
    )
    if current is None:
        current = ShopPrice(product_id=product.id, shop_id=shop.id)
        session.add(current)
    if payload.regular_price != current.regular_price:
        current.regular_price = payload.regular_price
        current.regular_on = payload.observed_on if payload.regular_price is not None else None
    if payload.sale_price is None:
        current.sale_price = current.sale_on = current.sale_until = None
    elif (payload.sale_price, payload.sale_until) != (current.sale_price, current.sale_until):
        set_sale(current, payload.sale_price, payload.observed_on, payload.sale_until)
    current.reviewed_on = payload.observed_on
    current.reviewed_price = payload.sale_price or payload.regular_price
    session.commit()
    return _detail(session, product)


@router.delete("/products/{product_id}/prices/{shop_id}", status_code=status.HTTP_204_NO_CONTENT)
def forget_price(
    product_id: uuid.UUID, shop_id: uuid.UUID, membership: Membership, session: DbSession
) -> None:
    product = _get(session, membership.team_id, product_id)
    current = session.scalar(
        select(ShopPrice).where(ShopPrice.product_id == product.id, ShopPrice.shop_id == shop_id)
    )
    if current is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no saved price at that shop")
    session.delete(current)
    session.commit()


@router.post("/prices/review", status_code=status.HTTP_204_NO_CONTENT)
def review_prices(payload: PriceReviewIn, membership: Membership, session: DbSession) -> None:
    """Answer "this receipt has a new price -- update it?" for one or more goods.

    ``regular`` makes it the shop's price; ``sale`` keeps the regular price and
    records a temporary one until ``sale_until`` (a week if left out); ``keep``
    changes nothing and stops asking about that receipt.
    """
    team_id = membership.team_id
    for answer in payload.decisions:
        product = _get(session, team_id, answer.product_id)
        shop = _shop(session, team_id, answer.shop_id)
        seen = Observation(
            product_id=product.id,
            shop_id=shop.id,
            observed_on=answer.observed_on,
            price=answer.price,
            on_sale=answer.decision == "sale",
            regular_price=answer.regular_price,
        )
        current = session.scalar(
            select(ShopPrice).where(
                ShopPrice.product_id == product.id, ShopPrice.shop_id == shop.id
            )
        )
        if current is None:
            if answer.decision == "keep":
                continue
            current = first_sighting(product.id, seen)
            session.add(current)
            session.flush()
        decide(current, seen, answer.decision, answer.sale_until)
        session.flush()
    session.commit()


@router.get("/prices/savings", response_model=SavingsOut)
def savings(team: TeamDep, session: DbSession) -> SavingsOut:
    """How tracked purchases compare with each good's usual price at the time.

    A saving needs a reason -- a sale, or a shop cheaper than the others --
    so a purchase at the only known shop at full price counts as zero, and
    one at a dearer shop counts against.
    """
    rows = session.execute(
        select(
            ExpenseItem.expense_id,
            ExpenseItem.product_id,
            Expense.shop_id,
            Expense.spent_at,
            ExpenseItem.total,
            ExpenseItem.quantity,
            ExpenseItem.on_sale,
            ExpenseItem.regular_unit_price,
        )
        .join(Expense, Expense.id == ExpenseItem.expense_id)
        .where(
            Expense.team_id == team.id,
            Expense.shop_id.is_not(None),
            ExpenseItem.product_id.is_not(None),
            ExpenseItem.total > 0,
        )
    ).all()
    purchases = [Purchase(*row) for row in rows]
    saved_prices = list(
        session.scalars(
            select(ShopPrice)
            .join(Product, Product.id == ShopPrice.product_id)
            .where(Product.team_id == team.id)
        )
    )
    seen = regular_prices(purchases, saved_prices)

    saved = extra = on_sale = compared = 0
    days: dict[date, list[int]] = defaultdict(lambda: [0, 0])
    by_product: dict[uuid.UUID, int] = defaultdict(int)
    for purchase in purchases:
        amount = saved_on(purchase, seen.get(purchase.product_id, []))
        if amount is None:
            continue
        compared += 1
        day = days[purchase.spent_at]
        day[0] += amount
        day[1] += 1
        if amount > 0:
            saved += amount
            if purchase.on_sale:
                on_sale += amount
        else:
            extra -= amount
        by_product[purchase.product_id] += amount

    top = sorted(((a, p) for p, a in by_product.items() if a > 0), reverse=True)[:5]
    names = dict(
        session.execute(
            select(Product.id, Product.name).where(Product.id.in_([p for _, p in top]))
        ).all()
    )
    return SavingsOut(
        currency=team.currency,
        saved=saved,
        extra=extra,
        on_sale=on_sale,
        compared=compared,
        purchases=len(purchases),
        days=[
            SavingsDayOut(date=key, total=value[0], expense_count=value[1])
            for key, value in sorted(days.items())
        ],
        best=[SavingsProductOut(product_id=p, name=names[p], saved=a) for a, p in top],
    )
