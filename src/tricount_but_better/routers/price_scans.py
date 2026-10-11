"""Prices read off a screenshot or photo of a shop's prices, then saved by hand.

Nothing is bought here, so no expense is made: the result is the shop's saved
prices, the same ones a receipt's first purchase sets. The scan only proposes;
every row is checked in the app before ``import`` saves it.
"""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from ..catalog import link_products, name_key, set_listed
from ..config import get_settings
from ..deps import DbSession, Membership, TeamDep
from ..models import Product, Shop, ShopPrice
from ..money import MoneyError, to_minor
from ..schemas import (
    PriceImportIn,
    PriceImportOut,
    PriceScanIn,
    PriceScanOut,
    ScannedPriceOut,
)
from ..vlm import VlmError, VlmUnavailable, get_parser
from ..vlm.schema import ParsedPriceList
from .receipts import ScanCatalog, clip_text, decode_images

router = APIRouter(prefix="/teams/{team_id}/prices", tags=["goods"])


def _minor(amount: Decimal | None, currency: str) -> int | None:
    """A positive amount in minor units, or None for a missing or unusable one."""
    if amount is None:
        return None
    try:
        value = to_minor(amount, currency)
    except MoneyError:
        return None
    return value if value > 0 else None


def _to_out(parsed: ParsedPriceList, currency: str, catalog: ScanCatalog) -> PriceScanOut:
    shop = catalog.shop(None, parsed.shop_name, parsed.shop_id, parsed.shop_address)
    listed = [item for item in parsed.items if name_key(item.name)]
    matches = catalog.products(
        [(item.name, item.product_name, item.product_id) for item in listed], shop.shop_id
    )
    items = []
    for item, (product_id, matched_by) in zip(listed, matches, strict=True):
        price = _minor(item.price, currency)
        regular = _minor(item.regular_price, currency)
        items.append(
            ScannedPriceOut(
                name=clip_text(item.name, 200) or item.name[:200],
                product_name=clip_text(item.product_name, 200),
                product_id=product_id,
                product_match=matched_by,
                price=price,
                # An "old price" no higher than the price is not a sale.
                regular_price=regular if regular and price and regular > price else None,
                sale_until=item.sale_until,
            )
        )
    if not items:
        raise VlmError("no prices found in these images")
    return PriceScanOut(shop=shop, currency=currency, items=items, notes=parsed.notes)


@router.post("/scan", response_model=PriceScanOut)
async def scan_prices(
    payload: PriceScanIn, membership: Membership, team: TeamDep, session: DbSession
) -> PriceScanOut:
    """Read goods and prices off screenshots or photos; nothing is saved."""
    settings = get_settings()
    images = decode_images(payload.images, "scan")
    catalog = ScanCatalog(session, team, settings.vlm_known_products)
    session.commit()  # no open read transaction across the slow model call
    try:
        result = await get_parser(settings).parse_prices(images, catalog.hints, payload.today)
        return _to_out(result.prices, result.prices.currency or team.currency, catalog)
    except VlmUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except VlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.post("/import", response_model=PriceImportOut)
def import_prices(
    payload: PriceImportIn, membership: Membership, session: DbSession
) -> PriceImportOut:
    """Save checked prices for one shop: each becomes that shop's price.

    A line with a higher old price is a sale until ``sale_until`` (a week if
    left out), with the old price as the regular one. Goods are matched the
    way receipt lines are -- chosen, then by the name this shop shows, then by
    name -- and new ones are created; the shown name is remembered per shop.
    """
    team_id = membership.team_id
    shop = session.get(Shop, payload.shop_id)
    if shop is None or shop.team_id != team_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "unknown shop")
    chosen = {item.product_id for item in payload.items if item.product_id is not None}
    if chosen:
        valid = set(
            session.scalars(
                select(Product.id).where(Product.team_id == team_id, Product.id.in_(chosen))
            )
        )
        if unknown := chosen - valid:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"unknown product: {next(iter(unknown))}"
            )
    items = [item for item in payload.items if name_key(item.name)]
    if not items:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "every item needs a name")

    known = set(session.scalars(select(Product.id).where(Product.team_id == team_id)))
    linked = link_products(
        session,
        team_id,
        shop.id,
        [(item.name, item.product_id, item.product_name) for item in items],
    )
    saved = {
        price.product_id: price
        for price in session.scalars(
            select(ShopPrice).where(ShopPrice.shop_id == shop.id, ShopPrice.product_id.in_(linked))
        )
    }
    for item, product_id in zip(items, linked, strict=True):
        current = saved.get(product_id)
        if current is None:
            current = saved[product_id] = ShopPrice(product_id=product_id, shop_id=shop.id)
            session.add(current)
        set_listed(current, item.price, payload.observed_on, item.regular_price, item.sale_until)
    session.commit()
    return PriceImportOut(saved=len(items), created=len(set(linked) - known))
