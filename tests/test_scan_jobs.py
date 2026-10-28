"""Scans read in the background: started, followed from anywhere, picked up once."""

from __future__ import annotations

import asyncio
import time
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from test_receipts import SAMPLE, FakeParser, _data_url, _jpeg

from tricount_but_better import scan_jobs
from tricount_but_better.config import get_settings
from tricount_but_better.models import Receipt, ReceiptImage
from tricount_but_better.routers import price_scans
from tricount_but_better.routers import receipts as receipts_router
from tricount_but_better.vlm.base import ParseResult, PriceListResult, VlmError
from tricount_but_better.vlm.schema import ParsedPrice, ParsedPriceList


@pytest.fixture(autouse=True)
def _parser(monkeypatch, scanning_enabled):
    parser = FakeParser(receipt=SAMPLE)
    monkeypatch.setattr(receipts_router, "get_parser", lambda settings: parser)
    return parser


@pytest.fixture
def scanning_enabled():
    settings = get_settings()
    original = settings.polza_api_key
    settings.polza_api_key = "test-key"
    yield
    settings.polza_api_key = original


class SlowParser:
    """Reads until told to stop, so a scan can be caught mid-read."""

    def __init__(self) -> None:
        self.cancelled = False

    async def parse(self, images, hints=None):
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        raise AssertionError("never finishes")


def _start(client, team, actor, *images: bytes):
    return client.post(
        f"/api/teams/{team}/receipts/jobs",
        json={"images": [_data_url(image) for image in images or (_jpeg(),)]},
        headers=actor.headers,
    )


def _wait(client, actor, job_id: str) -> dict:
    """The scan once it has stopped reading."""
    for _ in range(500):
        response = client.get(f"/api/scans/{job_id}", headers=actor.headers)
        assert response.status_code == 200, response.text
        if response.json()["status"] != "reading":
            return response.json()
        time.sleep(0.01)
    raise AssertionError("the scan never finished")


def test_a_receipt_is_read_in_the_background_and_picked_up_once(
    client, team, alice, session
) -> None:
    started = _start(client, team, alice)
    assert started.status_code == 202, started.text
    job = started.json()
    assert job["kind"] == "receipt"
    assert job["team_id"] == team

    done = _wait(client, alice, job["id"])
    assert done["status"] == "done"
    assert done["error"] is None
    assert [item["name"] for item in done["result"]["items"]] == ["Chicken breast", "Napkins"]
    assert done["result"]["parsed_total"] == 523_22

    # The list follows it without carrying the lines.
    listed = client.get("/api/scans", headers=alice.headers).json()
    assert [(j["id"], j["status"]) for j in listed] == [(job["id"], "done")]
    assert "result" not in listed[0]

    assert client.delete(f"/api/scans/{job['id']}", headers=alice.headers).status_code == 204
    assert client.get(f"/api/scans/{job['id']}", headers=alice.headers).status_code == 404
    assert client.get("/api/scans", headers=alice.headers).json() == []
    # Still nothing about the scan is stored.
    assert session.scalar(select(func.count()).select_from(Receipt)) == 0
    assert session.scalar(select(func.count()).select_from(ReceiptImage)) == 0


def test_a_failed_read_says_why(client, team, alice, _parser) -> None:
    _parser.error = VlmError("the photo is too blurry to read")
    job = _wait(client, alice, _start(client, team, alice).json()["id"])
    assert job["status"] == "failed"
    assert "too blurry" in job["error"]
    assert job["result"] is None


def test_an_unexpected_failure_is_reported_without_details(client, team, alice, _parser) -> None:
    _parser.error = KeyError("internal")
    job = _wait(client, alice, _start(client, team, alice).json()["id"])
    assert job["status"] == "failed"
    assert job["error"] == "could not read these images"


def test_photos_are_checked_before_a_scan_starts(client, team, alice) -> None:
    assert _start(client, team, alice, b"this is not an image").status_code == 422
    assert client.get("/api/scans", headers=alice.headers).json() == []


def test_only_whoever_started_a_scan_can_follow_it(client, team, alice, bob) -> None:
    job = _start(client, team, alice).json()
    _wait(client, alice, job["id"])
    # Bob is in the same team, but these are Alice's photos.
    assert client.get(f"/api/scans/{job['id']}", headers=bob.headers).status_code == 404
    assert client.delete(f"/api/scans/{job['id']}", headers=bob.headers).status_code == 404
    assert client.get("/api/scans", headers=bob.headers).json() == []
    assert client.get(f"/api/scans/{job['id']}", headers=alice.headers).status_code == 200


def test_outsiders_cannot_start_one(client, team) -> None:
    outsider = client.post(
        "/api/auth/register",
        json={"email": "m@example.com", "display_name": "M", "password": "correct-horse-battery"},
    ).json()
    response = client.post(
        f"/api/teams/{team}/receipts/jobs",
        json={"images": [_data_url(_jpeg())]},
        headers={"Authorization": f"Bearer {outsider['access_token']}"},
    )
    assert response.status_code == 404


def test_leaving_the_team_loses_its_scans(client, team, bob) -> None:
    job = _start(client, team, bob).json()
    _wait(client, bob, job["id"])
    left = client.delete(f"/api/teams/{team}/members/{bob.id}", headers=bob.headers)
    assert left.status_code == 204, left.text
    assert client.get(f"/api/scans/{job['id']}", headers=bob.headers).status_code == 404


def test_discarding_a_scan_stops_the_read(client, team, alice, monkeypatch) -> None:
    parser = SlowParser()
    monkeypatch.setattr(receipts_router, "get_parser", lambda settings: parser)
    job = _start(client, team, alice).json()
    assert client.get(f"/api/scans/{job['id']}", headers=alice.headers).json()["status"] == (
        "reading"
    )
    assert client.delete(f"/api/scans/{job['id']}", headers=alice.headers).status_code == 204
    for _ in range(500):
        if parser.cancelled:
            break
        time.sleep(0.01)
    assert parser.cancelled
    assert client.get("/api/scans", headers=alice.headers).json() == []


def test_one_person_can_only_have_a_few_reading_at_once(
    client, team, alice, bob, monkeypatch
) -> None:
    monkeypatch.setattr(receipts_router, "get_parser", lambda settings: SlowParser())
    for _ in range(scan_jobs.MAX_READING):
        assert _start(client, team, alice).status_code == 202
    refused = _start(client, team, alice)
    assert refused.status_code == 429
    assert "at once" in refused.json()["detail"]
    # Someone else's scans don't count against Alice.
    assert _start(client, team, bob).status_code == 202


def test_a_result_nobody_picks_up_is_dropped(client, team, alice, monkeypatch) -> None:
    job = _start(client, team, alice).json()
    _wait(client, alice, job["id"])
    monkeypatch.setattr(scan_jobs, "RESULT_TTL", -1)
    assert client.get(f"/api/scans/{job['id']}", headers=alice.headers).status_code == 404
    assert client.get("/api/scans", headers=alice.headers).json() == []


def test_prices_are_read_in_the_background_too(client, team, alice, monkeypatch) -> None:
    class PriceParser:
        today = None

        async def parse(self, images, hints=None):  # pragma: no cover - not a receipt
            return ParseResult(receipt=SAMPLE)

        async def parse_prices(self, images, hints=None, today=None):
            PriceParser.today = today
            return PriceListResult(
                prices=ParsedPriceList(
                    shop_name="Пятёрочка",
                    currency="RUB",
                    items=[ParsedPrice(name="Хлеб Бородинский", price=Decimal("54.90"))],
                )
            )

    monkeypatch.setattr(price_scans, "get_parser", lambda settings: PriceParser())
    started = client.post(
        f"/api/teams/{team}/prices/scan/jobs",
        json={"images": [_data_url(_jpeg())], "today": "2026-10-20"},
        headers=alice.headers,
    )
    assert started.status_code == 202, started.text
    assert started.json()["kind"] == "prices"
    job = _wait(client, alice, started.json()["id"])
    assert job["status"] == "done"
    assert [(item["name"], item["price"]) for item in job["result"]["items"]] == [
        ("Хлеб Бородинский", 54_90)
    ]
    assert job["result"]["shop"]["name"] == "Пятёрочка"
    assert PriceParser.today == date(2026, 10, 20)
