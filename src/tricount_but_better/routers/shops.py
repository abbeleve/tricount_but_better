"""Per-team shops: where things were bought, so prices can be compared."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..catalog import remember_shop_alias, shop_key
from ..deps import DbSession, Membership
from ..models import Expense, Shop, ShopPrice
from ..schemas import ShopAliasIn, ShopCreate, ShopOut, ShopUpdate

router = APIRouter(prefix="/teams/{team_id}/shops", tags=["shops"])

_TAKEN = "a shop with that name already exists"


def _serialise(session: DbSession, shops: list[Shop]) -> list[ShopOut]:
    ids = [shop.id for shop in shops]
    counts = dict(
        session.execute(
            select(ShopPrice.shop_id, func.count(ShopPrice.id))
            .where(ShopPrice.shop_id.in_(ids))
            .group_by(ShopPrice.shop_id)
        ).all()
    )
    visits = dict(
        session.execute(
            select(Expense.shop_id, func.max(Expense.spent_at))
            .where(Expense.shop_id.in_(ids))
            .group_by(Expense.shop_id)
        ).all()
    )
    return [
        ShopOut(
            id=shop.id,
            name=shop.name,
            address=shop.address,
            aliases=shop.aliases,
            product_count=counts.get(shop.id, 0),
            last_visit=visits.get(shop.id),
        )
        for shop in shops
    ]


def _key(name: str) -> str:
    key = shop_key(name)
    if not key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "a shop needs a name")
    return key


def _get(session: DbSession, team_id: uuid.UUID, shop_id: uuid.UUID) -> Shop:
    shop = session.get(Shop, shop_id)
    if shop is None or shop.team_id != team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "shop not found")
    return shop


def _commit(session: DbSession) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, _TAKEN) from exc


@router.get("", response_model=list[ShopOut])
def list_shops(membership: Membership, session: DbSession) -> list[ShopOut]:
    shops = session.scalars(
        select(Shop).where(Shop.team_id == membership.team_id).order_by(Shop.name)
    ).all()
    return _serialise(session, list(shops))


@router.post("", response_model=ShopOut, status_code=status.HTTP_201_CREATED)
def create_shop(payload: ShopCreate, membership: Membership, session: DbSession) -> ShopOut:
    shop = Shop(
        team_id=membership.team_id,
        name=payload.name,
        key=_key(payload.name),
        address=payload.address.strip(),
        aliases=[],
    )
    remember_shop_alias(shop, payload.alias)
    session.add(shop)
    _commit(session)
    return _serialise(session, [shop])[0]


@router.patch("/{shop_id}", response_model=ShopOut)
def update_shop(
    shop_id: uuid.UUID, payload: ShopUpdate, membership: Membership, session: DbSession
) -> ShopOut:
    shop = _get(session, membership.team_id, shop_id)
    if payload.name is not None:
        shop.name = payload.name
        shop.key = _key(payload.name)
    if payload.address is not None:
        shop.address = payload.address.strip()
    _commit(session)
    return _serialise(session, [shop])[0]


@router.post("/{shop_id}/aliases", response_model=ShopOut)
def add_alias(
    shop_id: uuid.UUID, payload: ShopAliasIn, membership: Membership, session: DbSession
) -> ShopOut:
    """Remember that receipts print this shop's name this way.

    A printed name belongs to one shop: if another shop had it, it moves here,
    because the person who just chose is the one who knows.
    """
    shop = _get(session, membership.team_id, shop_id)
    key = shop_key(payload.alias)
    others = session.scalars(
        select(Shop).where(Shop.team_id == membership.team_id, Shop.id != shop.id)
    ).all()
    for other in others:
        if other.key == key:
            raise HTTPException(status.HTTP_409_CONFLICT, "that is another shop's name")
        kept = [alias for alias in other.aliases if shop_key(alias) != key]
        if len(kept) != len(other.aliases):
            other.aliases = kept
    remember_shop_alias(shop, payload.alias)
    session.commit()
    return _serialise(session, [shop])[0]


@router.delete("/{shop_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shop(shop_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    """Forget a shop and its saved prices. Expenses stay; they lose the shop."""
    session.delete(_get(session, membership.team_id, shop_id))
    session.commit()
