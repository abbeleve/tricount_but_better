"""Read receipt photos in memory and return editable lines without storing them."""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..catalog import (
    Levels,
    alias_products,
    find_shop,
    levels_from,
    name_key,
    products_by_key,
    products_by_levels,
)
from ..config import get_settings
from ..db import SessionLocal
from ..deps import DbSession, Membership, TeamDep
from ..images import ImageError, normalise_image
from ..models import Expense, ExpenseItem, Product, Shop, Team, TeamMember
from ..money import MoneyError, to_minor
from ..scan_jobs import ScanJob, ScanKind, TooManyScans
from ..scan_jobs import jobs as scan_jobs
from ..schemas import (
    ParsedItemOut,
    ProductLevels,
    ProductMatch,
    ReceiptScanOut,
    ScanJobOut,
    ShopMatchOut,
)
from ..vlm import KnownProduct, KnownShop, ScanHints, VlmError, VlmUnavailable, get_parser
from ..vlm.schema import ParsedLevels, ParsedReceipt

router = APIRouter(prefix="/teams/{team_id}/receipts", tags=["receipts"])
_DATA_URL = re.compile(r"^data:image/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$")


class ReceiptScanIn(BaseModel):
    images: list[str] = Field(min_length=1)


class ScanCatalog:
    """The team's shops, recent goods and kinds of goods, with the short refs the
    model sees.

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
        # The commonest kinds first, should the list ever outgrow the limit.
        kinds = session.scalars(
            select(func.min(Product.kind))
            .where(Product.team_id == team.id, Product.kind_key.is_not(None))
            .group_by(Product.kind_key)
            .order_by(func.count().desc(), func.min(Product.kind))
            .limit(limit)
        )
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
            kinds=list(kinds),
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
        self,
        lines: list[tuple[str, str | None, str | None, Levels | None]],
        shop_id: uuid.UUID | None,
    ) -> list[tuple[uuid.UUID | None, ProductMatch | None]]:
        """Each (name as printed, readable name, model's ref, levels)'s product,
        by how sure the match is: this shop printed the name that way before, a
        known good has the same levels, the model recognised it, or the names
        agree."""
        names = [name for name, _, _, _ in lines]
        by_alias = alias_products(self.session, shop_id, names) if shop_id else {}
        by_levels = products_by_levels(self.session, self.team_id, [levels for *_, levels in lines])
        by_name = products_by_key(
            self.session, self.team_id, [*names, *(readable or "" for _, readable, _, _ in lines)]
        )
        matches: list = []
        for (name, readable, ref, _), same_levels in zip(lines, by_levels, strict=True):
            if found := by_alias.get(name_key(name)):
                matches.append((found, "receipt"))
            elif same_levels is not None:
                matches.append((same_levels, "levels"))
            elif found := self.product_refs.get((ref or "").strip().lower()):
                matches.append((found, "model"))
            elif found := by_name.get(name_key(readable or "")) or by_name.get(name_key(name)):
                matches.append((found, "name"))
            else:
                matches.append((None, None))
        return matches


def job_out(job: ScanJob) -> ScanJobOut:
    return ScanJobOut(
        id=job.id,
        team_id=job.team_id,
        kind=job.kind,
        status=job.status,
        error=job.error,
        created_at=job.created_at,
    )


def parsed_levels(item: ParsedLevels) -> Levels | None:
    return levels_from(
        item.kind, item.variety, item.brand, item.size_amount, item.size_unit, item.by_weight
    )


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
    levels = [parsed_levels(item) for item in parsed.items]
    matches = catalog.products(
        [
            (item.name, item.product_name, item.product_id, described)
            for item, described in zip(parsed.items, levels, strict=True)
        ],
        shop.shop_id,
    )
    items = []
    for item, described, (product_id, matched_by) in zip(
        parsed.items, levels, matches, strict=True
    ):
        try:
            total = to_minor(item.total, currency) if item.total is not None else None
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
                levels=ProductLevels.of(described),
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
        items_total=sum(item.total for item in items if item.total is not None),
        notes=parsed.notes,
    )


async def read_receipt(session: Session, team: Team, images: list[bytes]) -> ReceiptScanOut:
    """Read receipt photos into lines matched to the team's shops and goods.

    Raises VlmError when nothing usable comes back.
    """
    settings = get_settings()
    catalog = ScanCatalog(session, team, settings.vlm_known_products)
    # End the read transaction before the slow part: a scan can take minutes,
    # and an open SQLite snapshot that long holds back the WAL checkpoint.
    session.commit()
    result = await get_parser(settings).parse(images, catalog.hints)
    return _to_out(result.receipt, result.receipt.currency or team.currency, catalog)


def start_scan(
    membership: TeamMember,
    kind: ScanKind,
    read: Callable[[Session, Team], Awaitable[BaseModel]],
) -> ScanJobOut:
    """Hand a scan to a background job; the photos are already checked."""

    async def work() -> BaseModel:
        # The request's session is gone by the time the model answers.
        with SessionLocal() as session:
            team = session.get(Team, membership.team_id)
            if team is None:
                raise VlmError("this team no longer exists")
            return await read(session, team)

    try:
        job = scan_jobs.start(membership.user_id, membership.team_id, kind, work)
    except TooManyScans as exc:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(exc)) from exc
    return job_out(job)


@router.post("", response_model=ReceiptScanOut)
async def scan_receipt(
    payload: ReceiptScanIn,
    membership: Membership,
    team: TeamDep,
    session: DbSession,
) -> ReceiptScanOut:
    """Read a receipt within the request. The app starts a job instead; see below."""
    images = decode_images(payload.images)
    try:
        return await read_receipt(session, team, images)
    except VlmUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except VlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.post("/jobs", response_model=ScanJobOut, status_code=status.HTTP_202_ACCEPTED)
async def start_receipt_scan(payload: ReceiptScanIn, membership: Membership) -> ScanJobOut:
    """Read a receipt in the background; ``/api/scans/{id}`` says when it is done."""
    images = decode_images(payload.images)
    return start_scan(
        membership, "receipt", lambda session, team: read_receipt(session, team, images)
    )
