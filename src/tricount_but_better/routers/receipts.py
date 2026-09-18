"""Receipt upload and AI extraction.

Upload responds immediately with a ``pending`` receipt and does the model call
in the background: a multi-page parse can take a minute, which is far longer
than a phone browser will hold an upload connection open. The client polls the
GET endpoint.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile, status

from ..config import get_settings
from ..db import SessionLocal
from ..deps import CurrentUser, DbSession, Membership, TeamDep
from ..images import ImageError, store_upload
from ..models import Receipt, ReceiptImage, ReceiptStatus, Team
from ..money import MoneyError, to_minor
from ..schemas import ParsedItemOut, ReceiptOut
from ..vlm import VlmError, VlmUnavailable, get_parser
from ..vlm.schema import ParsedReceipt

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/teams/{team_id}/receipts", tags=["receipts"])


def _to_out(receipt: Receipt) -> ReceiptOut:
    data = receipt.parsed or {}
    return ReceiptOut(
        id=receipt.id,
        status=receipt.status,
        error=receipt.error,
        merchant=data.get("merchant"),
        purchased_at=data.get("purchased_at"),
        currency=data.get("currency"),
        items=[ParsedItemOut(**item) for item in data.get("items", [])],
        parsed_total=data.get("parsed_total"),
        items_total=data.get("items_total", 0),
        notes=data.get("notes"),
    )


def _to_minor_payload(parsed: ParsedReceipt, currency: str) -> dict:
    """Convert the model's decimal strings into the ledger's minor units."""
    items = []
    for item in parsed.items:
        try:
            total = to_minor(item.total, currency)
        except MoneyError:
            continue  # a single unreadable line should not sink the receipt
        items.append(
            {
                "name": item.name,
                "quantity": str(item.quantity) if item.quantity is not None else None,
                "unit_price": (
                    to_minor(item.unit_price, currency) if item.unit_price is not None else None
                ),
                "total": total,
            }
        )
    return {
        "merchant": parsed.merchant,
        "purchased_at": parsed.purchased_at.isoformat() if parsed.purchased_at else None,
        "currency": currency,
        "items": items,
        "parsed_total": (to_minor(parsed.total, currency) if parsed.total is not None else None),
        "items_total": sum(i["total"] for i in items),
        "notes": parsed.notes,
    }


async def _parse_in_background(receipt_id: uuid.UUID) -> None:
    """Run the model and record the outcome. Never raises into the task runner."""
    settings = get_settings()
    session = SessionLocal()
    try:
        receipt = session.get(Receipt, receipt_id)
        if receipt is None:  # pragma: no cover - deleted mid-flight
            return
        receipt.status = ReceiptStatus.processing
        session.commit()

        team = session.get(Team, receipt.team_id)
        paths = [Path(img.path) for img in receipt.images]

        try:
            result = await get_parser(settings).parse(paths)
        except (VlmError, VlmUnavailable) as exc:
            receipt.status = ReceiptStatus.failed
            receipt.error = str(exc)
            session.commit()
            return

        currency = result.receipt.currency or (team.currency if team else "RUB")
        receipt.parsed = _to_minor_payload(result.receipt, currency)
        receipt.cost_usd = result.cost_usd
        receipt.status = ReceiptStatus.parsed
        receipt.error = None
        session.commit()
    except Exception:  # pragma: no cover - last-resort guard
        logger.exception("receipt %s failed unexpectedly", receipt_id)
        session.rollback()
        receipt = session.get(Receipt, receipt_id)
        if receipt is not None:
            receipt.status = ReceiptStatus.failed
            receipt.error = "an unexpected error occurred while reading this receipt"
            session.commit()
    finally:
        session.close()


@router.post("", response_model=ReceiptOut, status_code=status.HTTP_202_ACCEPTED)
async def upload_receipt(
    background: BackgroundTasks,
    membership: Membership,
    team: TeamDep,
    user: CurrentUser,
    session: DbSession,
    files: Annotated[list[UploadFile], File(description="Receipt photos, in page order")],
) -> ReceiptOut:
    settings = get_settings()
    if settings.vlm_provider == "disabled":
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "receipt scanning is disabled")
    if not files:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "no images uploaded")
    if len(files) > settings.max_receipt_images:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"at most {settings.max_receipt_images} images per receipt",
        )

    receipt = Receipt(team_id=team.id, uploaded_by_id=user.id, status=ReceiptStatus.pending)
    session.add(receipt)
    session.flush()

    dest = settings.upload_dir / str(team.id) / str(receipt.id)
    for index, upload in enumerate(files):
        data = await upload.read()
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"'{upload.filename}' is larger than {settings.max_upload_mb} MB",
            )
        try:
            path, media_type, size = store_upload(data, dest, index)
        except ImageError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"'{upload.filename}': {exc}"
            ) from exc
        session.add(
            ReceiptImage(
                receipt_id=receipt.id,
                path=str(path),
                media_type=media_type,
                size_bytes=size,
            )
        )

    session.commit()
    background.add_task(_parse_in_background, receipt.id)
    return _to_out(receipt)


@router.get("/{receipt_id}", response_model=ReceiptOut)
def get_receipt(receipt_id: uuid.UUID, membership: Membership, session: DbSession) -> ReceiptOut:
    receipt = session.get(Receipt, receipt_id)
    if receipt is None or receipt.team_id != membership.team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "receipt not found")
    return _to_out(receipt)
