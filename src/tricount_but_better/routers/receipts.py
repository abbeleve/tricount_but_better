"""Read receipt photos in memory and return editable lines without storing them."""

from __future__ import annotations

import base64
import binascii
import re

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..config import get_settings
from ..deps import Membership, TeamDep
from ..images import ImageError, normalise_image
from ..money import MoneyError, to_minor
from ..schemas import ParsedItemOut, ReceiptScanOut
from ..vlm import VlmError, VlmUnavailable, get_parser
from ..vlm.schema import ParsedReceipt

router = APIRouter(prefix="/teams/{team_id}/receipts", tags=["receipts"])
_DATA_URL = re.compile(r"^data:image/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$")


class ReceiptScanIn(BaseModel):
    images: list[str] = Field(min_length=1)


def _to_out(parsed: ParsedReceipt, currency: str) -> ReceiptScanOut:
    items = []
    for item in parsed.items:
        try:
            total = to_minor(item.total, currency)
            unit_price = (
                to_minor(item.unit_price, currency) if item.unit_price is not None else None
            )
        except MoneyError:
            continue
        items.append(
            ParsedItemOut(
                name=item.name,
                quantity=item.quantity,
                unit_price=unit_price,
                total=total,
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
) -> ReceiptScanOut:
    settings = get_settings()
    if settings.vlm_provider == "disabled":
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "receipt scanning is disabled")
    if len(payload.images) > settings.max_receipt_images:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"at most {settings.max_receipt_images} images per receipt",
        )

    images = []
    for data_url in payload.images:
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

    try:
        result = await get_parser(settings).parse(images)
        return _to_out(result.receipt, result.receipt.currency or team.currency)
    except VlmUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except VlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
