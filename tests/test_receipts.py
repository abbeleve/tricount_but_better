"""Scanning is transient: only expense lines explicitly saved by the user persist."""

from __future__ import annotations

import base64
import io
from decimal import Decimal

import pytest
from PIL import Image
from sqlalchemy import func, select

from tricount_but_better.config import get_settings
from tricount_but_better.models import Receipt, ReceiptImage
from tricount_but_better.routers import receipts as receipts_router
from tricount_but_better.vlm.base import ParseResult, VlmError
from tricount_but_better.vlm.schema import ParsedItem, ParsedReceipt


@pytest.fixture
def scanning_enabled():
    settings = get_settings()
    original = settings.vlm_provider
    settings.vlm_provider = "polza"
    yield
    settings.vlm_provider = original


def _jpeg(color: tuple[int, int, int] = (240, 240, 240)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (600, 900), color).save(buffer, format="JPEG")
    return buffer.getvalue()


def _data_url(data: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def _scan(client, team, actor, *images: bytes):
    return client.post(
        f"/api/teams/{team}/receipts",
        json={"images": [_data_url(image) for image in images]},
        headers=actor.headers,
    )


class FakeParser:
    def __init__(self, receipt: ParsedReceipt | None = None, error: Exception | None = None):
        self.receipt = receipt
        self.error = error
        self.images: list[bytes] = []

    async def parse(self, images: list[bytes]):
        self.images = images
        if self.error is not None:
            raise self.error
        return ParseResult(receipt=self.receipt, cost_usd=None, model="fake")


def _install(monkeypatch, parser: FakeParser) -> FakeParser:
    monkeypatch.setattr(receipts_router, "get_parser", lambda settings: parser)
    return parser


SAMPLE = ParsedReceipt(
    merchant="Pyaterochka",
    purchased_at="2026-09-01",
    currency="RUB",
    items=[
        ParsedItem(
            name="Chicken breast",
            quantity=Decimal("0.482"),
            unit_price=Decimal("899.00"),
            total=Decimal("433.32"),
        ),
        ParsedItem(name="Napkins", total=Decimal("89.90")),
    ],
    total=Decimal("523.22"),
)


def test_scan_returns_lines_without_storing_a_receipt(
    client, team, alice, session, monkeypatch, scanning_enabled
) -> None:
    parser = _install(monkeypatch, FakeParser(receipt=SAMPLE))
    response = _scan(client, team, alice, _jpeg())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["merchant"] == "Pyaterochka"
    assert body["currency"] == "RUB"
    assert body["parsed_total"] == 523_22
    assert body["items_total"] == 433_32 + 89_90
    assert [item["name"] for item in body["items"]] == ["Chicken breast", "Napkins"]
    assert body["items"][0]["unit_price"] == 899_00
    assert len(parser.images) == 1
    assert parser.images[0].startswith(b"\xff\xd8")
    assert session.scalar(select(func.count()).select_from(Receipt)) == 0
    assert session.scalar(select(func.count()).select_from(ReceiptImage)) == 0


def test_multiple_photos_reach_the_model_in_order(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    parser = _install(monkeypatch, FakeParser(receipt=SAMPLE))
    response = _scan(client, team, alice, _jpeg((255, 0, 0)), _jpeg((0, 0, 255)))
    assert response.status_code == 200, response.text
    first = Image.open(io.BytesIO(parser.images[0])).getpixel((0, 0))
    second = Image.open(io.BytesIO(parser.images[1])).getpixel((0, 0))
    assert first[0] > first[2]
    assert second[2] > second[0]


def test_model_error_and_empty_scan_are_reported(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    _install(monkeypatch, FakeParser(error=VlmError("the photo is too blurry to read")))
    response = _scan(client, team, alice, _jpeg())
    assert response.status_code == 502
    assert "too blurry" in response.json()["detail"]

    _install(monkeypatch, FakeParser(receipt=ParsedReceipt(items=[])))
    response = _scan(client, team, alice, _jpeg())
    assert response.status_code == 502
    assert "no line items" in response.json()["detail"]


def test_invalid_image_and_excess_pages_are_rejected(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    response = _scan(client, team, alice, b"this is not an image")
    assert response.status_code == 422
    response = _scan(client, team, alice, *[_jpeg()] * (get_settings().max_receipt_images + 1))
    assert response.status_code == 422


def test_scanning_can_be_disabled(client, team, alice) -> None:
    response = _scan(client, team, alice, _jpeg())
    assert response.status_code == 503


def test_outsider_cannot_scan(client, team, alice, scanning_enabled) -> None:
    outsider = client.post(
        "/api/auth/register",
        json={"email": "m@example.com", "display_name": "M", "password": "correct-horse-battery"},
    ).json()
    response = client.post(
        f"/api/teams/{team}/receipts",
        json={"images": [_data_url(_jpeg())]},
        headers={"Authorization": f"Bearer {outsider['access_token']}"},
    )
    assert response.status_code == 404


def test_scan_lines_can_be_saved_as_an_itemised_expense(
    client, team, alice, bob, carol, session, monkeypatch, scanning_enabled
) -> None:
    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    parsed = _scan(client, team, alice, _jpeg()).json()
    everyone = [{"user_id": actor.id} for actor in (alice, bob, carol)]
    response = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": parsed["merchant"],
            "payer_id": alice.id,
            "spent_at": parsed["purchased_at"],
            "split_mode": "items",
            "items": [
                {
                    "name": parsed["items"][0]["name"],
                    "total": parsed["items"][0]["total"],
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                },
                {
                    "name": parsed["items"][1]["name"],
                    "total": parsed["items"][1]["total"],
                    "shares": everyone,
                },
            ],
        },
        headers=alice.headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["receipt_id"] is None
    assert body["total"] == 523_22
    by_user = {share["user_id"]: share["amount"] for share in body["shares"]}
    assert by_user[carol.id] == 2996
    assert sum(by_user.values()) == body["total"]
    assert session.scalar(select(func.count()).select_from(Receipt)) == 0
    assert session.scalar(select(func.count()).select_from(ReceiptImage)) == 0


def test_scanned_lines_append_to_existing_manual_expense(
    client, team, alice, bob, session, monkeypatch, scanning_enabled
) -> None:
    created = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Dinner",
            "payer_id": alice.id,
            "spent_at": "2026-09-10",
            "split_mode": "items",
            "items": [{"name": "Manual dessert", "total": 75_00, "shares": [{"user_id": bob.id}]}],
        },
        headers=alice.headers,
    )
    assert created.status_code == 201, created.text
    expense_id = created.json()["id"]

    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    parsed = _scan(client, team, alice, _jpeg()).json()
    response = client.put(
        f"/api/teams/{team}/expenses/{expense_id}",
        json={
            "title": "Dinner",
            "payer_id": alice.id,
            "spent_at": "2026-09-10",
            "split_mode": "items",
            "items": [
                {"name": "Manual dessert", "total": 75_00, "shares": [{"user_id": bob.id}]},
                {
                    "name": parsed["items"][0]["name"],
                    "quantity": parsed["items"][0]["quantity"],
                    "unit_price": parsed["items"][0]["unit_price"],
                    "total": parsed["items"][0]["total"],
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                },
            ],
        },
        headers=alice.headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "Dinner"
    assert body["spent_at"] == "2026-09-10"
    assert body["receipt_id"] is None
    assert [item["name"] for item in body["items"]] == ["Manual dessert", "Chicken breast"]
    assert body["items"][0]["shares"][0]["user_id"] == bob.id
    assert body["items"][1]["quantity"] == "0.482"
    assert body["items"][1]["unit_price"] == 899_00
    assert body["total"] == 75_00 + 433_32
    assert session.scalar(select(func.count()).select_from(Receipt)) == 0
    assert session.scalar(select(func.count()).select_from(ReceiptImage)) == 0
