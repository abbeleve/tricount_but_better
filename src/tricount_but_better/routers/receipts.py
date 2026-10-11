"""Read receipt photos in memory and return editable lines without storing them."""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..catalog import alias_products, find_shop, name_key, products_by_key
from ..config import get_settings
from ..deps import DbSession, Membership, TeamDep
from ..images import ImageError, normalise_image
from ..models import Expense, ExpenseItem, Product, Shop, Team
from ..money import MoneyError, to_minor
from ..schemas import ParsedItemOut, ReceiptScanOut, ShopMatchOut
from ..vlm import KnownProduct, KnownShop, ScanHints, VlmError, VlmUnavailable, get_parser
from ..vlm.schema import ParsedReceipt

router = APIRouter(prefix="/teams/{team_id}/receipts", tags=["receipts"])
_DATA_URL = re.compile(r"^data:image/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$")


class ReceiptScanIn(BaseModel):
    images: list[str] = Field(min_length=1)


class ScanCatalog:
    """The team's shops and recent goods, with the short refs the model sees.

    Shared by receipt and price-list scans: the same hints go to the model, and
    its answer is matched back the same way.
    """

    def __init__(self, session: Session, team: Team, limit: int) -> None:
        self.session = session
        self.team_id = team.id
        self.shops = list(session.scalars(select(Shop).where(Shop.team_id == team.id)))
        recent = session.execute(
            select(Product.id, Product.name)
            .outerjoin(ExpenseItem, ExpenseItem.product_id == Product.id)
            .outerjoin(Expense, Expense.id == ExpenseItem.expense_id)
            .where(Product.team_id == team.id)
            .group_by(Product.id, Product.name)
            .order_by(func.max(Expense.spent_at).desc().nulls_last(), Product.name)
            .limit(limit)
        ).all()
        self.shop_refs = {f"s{i}": shop for i, shop in enumerate(self.shops, 1)}
        self.product_refs = {f"p{i}": product_id for i, (product_id, _) in enumerate(recent, 1)}
        self.hints = ScanHints(
            shops=[
                KnownShop(ref=ref, name=shop.name, aliases=shop.aliases)
                for ref, shop in self.shop_refs.items()
            ],
            products=[
                KnownProduct(ref=ref, name=name)
                for ref, (_, name) in zip(self.product_refs, recent, strict=True)
            ],
        )

    def shop(
        self,
        merchant: str | None,
        shop_name: str | None,
        shop_ref: str | None,
        address: str | None,
    ) -> ShopMatchOut:
        """A printed name a shop is known by wins; the model's pick comes second."""
        suggestion = clip_text(shop_name or merchant, 120)
        address = clip_text(address, 240)
        match = find_shop(self.shops, merchant, shop_name)
        if match is not None:
            return ShopMatchOut(
                shop_id=match.id, matched_by="receipt", name=suggestion, address=address
            )
        match = self.shop_refs.get((shop_ref or "").strip().lower())
        return ShopMatchOut(
            shop_id=match.id if match else None,
            matched_by="model" if match else None,
            name=suggestion,
            address=address,
        )

    def products(
        self, lines: list[tuple[str, str | None, str | None]], shop_id: uuid.UUID | None
    ) -> list[tuple[uuid.UUID | None, Literal["receipt", "model", "name"] | None]]:
        """Each (name as printed, readable name, model's ref)'s product, by how
        sure the match is: this shop printed the name that way before, the
        model recognised it, or the names agree."""
        names = [name for name, _, _ in lines]
        by_alias = alias_products(self.session, shop_id, names) if shop_id else {}
        by_name = products_by_key(
            self.session, self.team_id, [*names, *(readable or "" for _, readable, _ in lines)]
        )
        matches: list = []
        for name, readable, ref in lines:
            if found := by_alias.get(name_key(name)):
                matches.append((found, "receipt"))
            elif found := self.product_refs.get((ref or "").strip().lower()):
                matches.append((found, "model"))
            elif found := by_name.get(name_key(readable or "")) or by_name.get(name_key(name)):
                matches.append((found, "name"))
            else:
                matches.append((None, None))
        return matches


def clip_text(text: str | None, limit: int) -> str | None:
    """Model text cut to what the API accepts back, so a long read can't fail a save."""
    return text.strip()[:limit] or None if text else None


def decode_images(data_urls: list[str], what: str = "receipt") -> list[bytes]:
    """Validate and re-encode uploaded data-URL images, in memory."""
    settings = get_settings()
    if len(data_urls) > settings.max_receipt_images:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"at most {settings.max_receipt_images} images per {what}",
        )
    images = []
    for data_url in data_urls:
        match = _DATA_URL.fullmatch(data_url)
        if match is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "not a readable image")
        encoded = match.group(1)
        if len(encoded) > 4 * ((settings.max_upload_bytes + 2) // 3):
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"image is larger than {settings.max_upload_mb} MB",
            )
        try:
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > settings.max_upload_bytes:
                raise HTTPException(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    f"image is larger than {settings.max_upload_mb} MB",
                )
            images.append(normalise_image(raw))
        except (binascii.Error, ImageError) as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "not a readable image"
            ) from exc
    return images


def _to_out(parsed: ParsedReceipt, currency: str, catalog: ScanCatalog) -> ReceiptScanOut:
    shop = catalog.shop(parsed.merchant, parsed.shop_name, parsed.shop_id, parsed.shop_address)
    matches = catalog.products(
        [(item.name, item.product_name, item.product_id) for item in parsed.items], shop.shop_id
    )
    items = []
    for item, (product_id, matched_by) in zip(parsed.items, matches, strict=True):
        try:
            total = to_minor(item.total, currency)
            unit_price = (
                to_minor(item.unit_price, currency) if item.unit_price is not None else None
            )
            regular = (
                to_minor(item.regular_price, currency) if item.regular_price is not None else None
            )
        except MoneyError:
            continue
        items.append(
            ParsedItemOut(
                name=clip_text(item.name, 200) or item.name,
                quantity=item.quantity,
                unit_price=unit_price,
                total=total,
                product_name=clip_text(item.product_name, 200),
                product_id=product_id,
                product_match=matched_by,
                on_sale=item.discounted,
                regular_unit_price=regular if regular and regular > 0 else None,
            )
        )
    if not items:
        raise VlmError("no line items found in this receipt")
    try:
        parsed_total = to_minor(parsed.total, currency) if parsed.total is not None else None
    except MoneyError:
        parsed_total = None
    return ReceiptScanOut(
        merchant=parsed.merchant,
        shop=shop,
        purchased_at=parsed.purchased_at,
        currency=currency,
        items=items,
        parsed_total=parsed_total,
        items_total=sum(item.total for item in items),
        notes=parsed.notes,
    )


@router.post("", response_model=ReceiptScanOut)
async def scan_receipt(
    payload: ReceiptScanIn,
    membership: Membership,
    team: TeamDep,
    session: DbSession,
) -> ReceiptScanOut:
    settings = get_settings()
    images = decode_images(payload.images)
    catalog = ScanCatalog(session, team, settings.vlm_known_products)
    # End the read transaction before the slow part: a scan can take minutes,
    # and an open SQLite snapshot that long holds back the WAL checkpoint.
    session.commit()
    try:
        result = await get_parser(settings).parse(images, catalog.hints)
        return _to_out(result.receipt, result.receipt.currency or team.currency, catalog)
    except VlmUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except VlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
