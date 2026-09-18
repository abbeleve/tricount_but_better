"""Receipt upload and extraction, with the model stubbed out.

No test here talks to a real model: the provider boundary is a Protocol, so a
fake that returns a ``ParsedReceipt`` exercises everything downstream of it --
image intake, minor-unit conversion, status transitions and failure handling.
"""

from __future__ import annotations

import io
from decimal import Decimal

import pytest
from PIL import Image

from tricount_but_better.config import get_settings
from tricount_but_better.routers import receipts as receipts_router
from tricount_but_better.vlm.base import ParseResult, VlmError
from tricount_but_better.vlm.schema import ParsedItem, ParsedReceipt


@pytest.fixture
def scanning_enabled():
    """Turn the feature on for the duration of one test."""
    settings = get_settings()
    original = settings.vlm_provider
    settings.vlm_provider = "agent_sdk"
    yield
    settings.vlm_provider = original


def _jpeg(width: int = 600, height: int = 900) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (240, 240, 240)).save(buffer, format="JPEG")
    return buffer.getvalue()


class FakeParser:
    def __init__(self, receipt: ParsedReceipt | None = None, error: Exception | None = None):
        self._receipt = receipt
        self._error = error
        self.seen_paths: list = []

    async def parse(self, image_paths):
        self.seen_paths = list(image_paths)
        if self._error is not None:
            raise self._error
        return ParseResult(receipt=self._receipt, cost_usd=Decimal("0.0123"), model="fake")


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


def test_upload_parses_and_converts_to_minor_units(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    parser = _install(monkeypatch, FakeParser(receipt=SAMPLE))

    uploaded = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("receipt.jpg", _jpeg(), "image/jpeg"))],
        headers=alice.headers,
    )
    assert uploaded.status_code == 202, uploaded.text
    receipt_id = uploaded.json()["id"]

    # TestClient drains background tasks before returning, so it is already done.
    fetched = client.get(f"/api/teams/{team}/receipts/{receipt_id}", headers=alice.headers).json()
    assert fetched["status"] == "parsed"
    assert fetched["merchant"] == "Pyaterochka"
    assert fetched["currency"] == "RUB"
    assert fetched["parsed_total"] == 523_22
    assert fetched["items_total"] == 433_32 + 89_90
    assert [i["name"] for i in fetched["items"]] == ["Chicken breast", "Napkins"]
    assert fetched["items"][0]["total"] == 433_32
    assert fetched["items"][0]["unit_price"] == 899_00
    assert len(parser.seen_paths) == 1
    assert parser.seen_paths[0].exists()


def test_multiple_pages_reach_the_model_in_order(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    parser = _install(monkeypatch, FakeParser(receipt=SAMPLE))
    client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", (f"page{i}.jpg", _jpeg(), "image/jpeg")) for i in range(3)],
        headers=alice.headers,
    )
    names = [p.name for p in parser.seen_paths]
    assert len(names) == 3
    assert names == sorted(names)  # page-00, page-01, page-02


def test_a_model_failure_is_reported_not_swallowed(
    client, team, alice, monkeypatch, scanning_enabled
) -> None:
    _install(monkeypatch, FakeParser(error=VlmError("the photo is too blurry to read")))

    uploaded = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("receipt.jpg", _jpeg(), "image/jpeg"))],
        headers=alice.headers,
    )
    receipt_id = uploaded.json()["id"]
    fetched = client.get(f"/api/teams/{team}/receipts/{receipt_id}", headers=alice.headers).json()
    assert fetched["status"] == "failed"
    assert "too blurry" in fetched["error"]


def test_non_images_are_rejected(client, team, alice, monkeypatch, scanning_enabled) -> None:
    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    refused = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("notes.txt", b"this is not an image", "text/plain"))],
        headers=alice.headers,
    )
    assert refused.status_code == 422
    assert "not a readable image" in refused.json()["detail"]


def test_too_many_pages_are_rejected(client, team, alice, monkeypatch, scanning_enabled) -> None:
    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    limit = get_settings().max_receipt_images
    refused = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", (f"p{i}.jpg", _jpeg(), "image/jpeg")) for i in range(limit + 1)],
        headers=alice.headers,
    )
    assert refused.status_code == 422


def test_scanning_can_be_turned_off(client, team, alice) -> None:
    # The `scanning_enabled` fixture is deliberately absent here.
    refused = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("receipt.jpg", _jpeg(), "image/jpeg"))],
        headers=alice.headers,
    )
    assert refused.status_code == 503


def test_outsiders_cannot_upload_to_a_team(
    client, team, bob, monkeypatch, scanning_enabled
) -> None:
    outsider = client.post(
        "/api/auth/register",
        json={"email": "m@example.com", "display_name": "M", "password": "correct-horse-battery"},
    ).json()
    refused = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("receipt.jpg", _jpeg(), "image/jpeg"))],
        headers={"Authorization": f"Bearer {outsider['access_token']}"},
    )
    assert refused.status_code == 404


def test_parsed_receipt_becomes_an_itemised_expense(
    client, team, alice, bob, carol, monkeypatch, scanning_enabled
) -> None:
    """The whole point: scan, then split the chicken between two of three."""
    _install(monkeypatch, FakeParser(receipt=SAMPLE))
    receipt_id = client.post(
        f"/api/teams/{team}/receipts",
        files=[("files", ("receipt.jpg", _jpeg(), "image/jpeg"))],
        headers=alice.headers,
    ).json()["id"]
    parsed = client.get(f"/api/teams/{team}/receipts/{receipt_id}", headers=alice.headers).json()

    everyone = [{"user_id": a.id} for a in (alice, bob, carol)]
    created = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": parsed["merchant"],
            "payer_id": alice.id,
            "spent_at": parsed["purchased_at"],
            "split_mode": "items",
            "receipt_id": receipt_id,
            "items": [
                {
                    "name": parsed["items"][0]["name"],
                    "total": parsed["items"][0]["total"],
                    # Carol does not eat chicken.
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
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["source"] == "receipt"
    assert body["receipt_id"] == receipt_id
    assert body["total"] == 433_32 + 89_90

    by_user = {s["user_id"]: s["amount"] for s in body["shares"]}
    # Napkins are 8990 across three: 2996 each with two leftover units, which
    # go to the first two participants. Carol pays for nothing else.
    assert by_user[carol.id] == 2996
    assert by_user[alice.id] == 433_32 // 2 + 2997
    assert sum(by_user.values()) == body["total"]
