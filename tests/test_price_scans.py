"""Prices read off a screenshot are proposed, checked, then saved as shop prices."""

from __future__ import annotations

import base64
import io
from datetime import date, timedelta
from decimal import Decimal

import pytest
from PIL import Image

from tricount_but_better.config import get_settings
from tricount_but_better.routers import price_scans
from tricount_but_better.vlm.base import PriceListResult, VlmError
from tricount_but_better.vlm.schema import ParsedPrice, ParsedPriceList

TODAY = date.today()


@pytest.fixture
def scanning_enabled():
    settings = get_settings()
    original = settings.polza_api_key
    settings.polza_api_key = "test-key"
    yield
    settings.polza_api_key = original


def _image() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (400, 700), (250, 250, 250)).save(buffer, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class FakeParser:
    def __init__(self, prices: ParsedPriceList | None = None, error: Exception | None = None):
        self.prices = prices
        self.error = error
        self.hints = None
        self.today = None

    async def parse_prices(self, images, hints=None, today=None):
        self.hints, self.today = hints, today
        if self.error is not None:
            raise self.error
        return PriceListResult(prices=self.prices, model="fake")


def _install(monkeypatch, parser: FakeParser) -> FakeParser:
    monkeypatch.setattr(price_scans, "get_parser", lambda settings: parser)
    return parser


def _scan(client, team, actor, **extra):
    return client.post(
        f"/api/teams/{team}/prices/scan",
        json={"images": [_image()], **extra},
        headers=actor.headers,
    )


def _shop(client, team, actor, name, alias=None):
    response = client.post(
        f"/api/teams/{team}/shops", json={"name": name, "alias": alias}, headers=actor.headers
    )
    assert response.status_code == 201, response.text
    return response.json()


def _import(client, team, actor, shop_id, items, observed_on=TODAY):
    return client.post(
        f"/api/teams/{team}/prices/import",
        json={"shop_id": shop_id, "observed_on": str(observed_on), "items": items},
        headers=actor.headers,
    )


def _product(client, team, actor, product_id):
    return client.get(f"/api/teams/{team}/products/{product_id}", headers=actor.headers).json()


LEAFLET = ParsedPriceList(
    shop_name="Пятёрочка",
    currency="RUB",
    items=[
        ParsedPrice(
            name="МОЛОКО ПРОСТОКВАШИНО 2,5% 930МЛ",
            product_name="Молоко Простоквашино 2,5% 930 мл",
            price=Decimal("79.99"),
            regular_price=Decimal("99.99"),
            sale_until=TODAY + timedelta(days=5),
        ),
        ParsedPrice(name="Хлеб Бородинский", price=Decimal("54.90")),
        # An "old price" lower than the price is a misread, not a sale.
        ParsedPrice(name="Сыр", price=Decimal("300"), regular_price=Decimal("250")),
        ParsedPrice(name="—", price=Decimal("10")),
    ],
)


def test_scan_proposes_prices_and_suggests_a_new_shop(
    client, team, alice, monkeypatch, scanning_enabled
):
    parser = _install(monkeypatch, FakeParser(LEAFLET))
    response = _scan(client, team, alice, today=str(TODAY))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["shop"] == {
        "shop_id": None,
        "matched_by": None,
        "name": "Пятёрочка",
        "address": None,
    }
    assert [item["name"] for item in body["items"]] == [
        "МОЛОКО ПРОСТОКВАШИНО 2,5% 930МЛ",
        "Хлеб Бородинский",
        "Сыр",
    ]
    milk, bread, cheese = body["items"]
    assert (milk["price"], milk["regular_price"], milk["sale_until"]) == (
        79_99,
        99_99,
        str(TODAY + timedelta(days=5)),
    )
    assert (bread["price"], bread["regular_price"]) == (54_90, None)
    assert (cheese["price"], cheese["regular_price"]) == (300_00, None)
    assert parser.today == TODAY
    # Nothing is saved by a scan.
    assert client.get(f"/api/teams/{team}/products", headers=alice.headers).json() == {
        "items": [],
        "total_count": 0,
    }


def test_scan_errors_are_reported(client, team, alice, monkeypatch, scanning_enabled):
    _install(monkeypatch, FakeParser(error=VlmError("the image is too blurry")))
    assert _scan(client, team, alice).status_code == 502
    _install(monkeypatch, FakeParser(ParsedPriceList(items=[])))
    response = _scan(client, team, alice)
    assert response.status_code == 502
    assert "no prices" in response.json()["detail"]


def test_import_saves_regular_and_sale_prices_and_creates_goods(client, team, alice):
    shop = _shop(client, team, alice, "Пятёрочка")
    response = _import(
        client,
        team,
        alice,
        shop["id"],
        [
            {
                "name": "МОЛОКО ПРОСТОКВАШИНО 2,5% 930МЛ",
                "product_name": "Молоко Простоквашино 2,5% 930 мл",
                "price": 79_99,
                "regular_price": 99_99,
            },
            {"name": "Хлеб Бородинский", "price": 54_90},
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"saved": 2, "created": 2}

    goods = client.get(
        f"/api/teams/{team}/products", params={"sort": "name"}, headers=alice.headers
    ).json()["items"]
    assert [g["name"] for g in goods] == ["Молоко Простоквашино 2,5% 930 мл", "Хлеб Бородинский"]
    milk = goods[0]["prices"][0]
    assert (milk["price"], milk["regular_price"], milk["on_sale"]) == (79_99, 99_99, True)
    assert milk["sale_until"] == str(TODAY + timedelta(days=7))
    assert goods[1]["prices"][0]["price"] == 54_90
    # No expense was made: these are prices seen, not bought.
    assert goods[0]["purchase_count"] == 0


def test_imported_names_are_remembered_so_the_next_scan_links_them(
    client, team, alice, monkeypatch, scanning_enabled
):
    shop = _shop(client, team, alice, "Пятёрочка")
    _import(client, team, alice, shop["id"], [{"name": "Хлеб Бородинский", "price": 54_90}])
    _install(monkeypatch, FakeParser(LEAFLET))
    body = _scan(client, team, alice).json()
    assert body["shop"]["shop_id"] == shop["id"]
    assert body["shop"]["matched_by"] == "receipt"
    bread = body["items"][1]
    assert bread["product_match"] == "receipt"
    assert bread["product_id"] is not None


def test_import_links_chosen_goods_and_ends_a_sale_with_a_plain_price(client, team, alice):
    shop = _shop(client, team, alice, "Lenta")
    _import(
        client,
        team,
        alice,
        shop["id"],
        [{"name": "Coffee", "price": 349_00, "regular_price": 499_00}],
        observed_on=TODAY - timedelta(days=2),
    )
    coffee = client.get(f"/api/teams/{team}/products", headers=alice.headers).json()["items"][0]
    response = _import(
        client,
        team,
        alice,
        shop["id"],
        [{"name": "Кофе в зёрнах 1 кг", "product_id": coffee["id"], "price": 529_00}],
    )
    assert response.json() == {"saved": 1, "created": 0}
    row = _product(client, team, alice, coffee["id"])["prices"][0]
    assert (row["price"], row["regular_price"], row["on_sale"]) == (529_00, 529_00, False)


def test_import_is_checked_against_the_team(client, team, alice, bob):
    shop = _shop(client, team, alice, "Lenta")
    other = client.post("/api/teams", json={"name": "Elsewhere"}, headers=bob.headers).json()["id"]
    foreign_shop = _shop(client, other, bob, "Metro")
    assert (
        _import(client, team, alice, foreign_shop["id"], [{"name": "Milk", "price": 1}]).status_code
        == 422
    )
    _import(client, other, bob, foreign_shop["id"], [{"name": "Milk", "price": 1}])
    foreign_product = client.get(f"/api/teams/{other}/products", headers=bob.headers).json()
    response = _import(
        client,
        team,
        alice,
        shop["id"],
        [{"name": "Milk", "price": 1, "product_id": foreign_product["items"][0]["id"]}],
    )
    assert response.status_code == 422
    late = _import(
        client,
        team,
        alice,
        shop["id"],
        [{"name": "Milk", "price": 1, "sale_until": str(TODAY - timedelta(days=1))}],
    )
    assert late.status_code == 422
    assert (
        _import(
            client, other, alice, foreign_shop["id"], [{"name": "Milk", "price": 1}]
        ).status_code
        == 404
    )


def test_the_same_good_twice_in_one_import_saves_once(client, team, alice):
    shop = _shop(client, team, alice, "Lenta")
    response = _import(
        client,
        team,
        alice,
        shop["id"],
        [{"name": "Milk", "price": 90_00}, {"name": "MILK", "price": 95_00}],
    )
    assert response.status_code == 200, response.text
    goods = client.get(f"/api/teams/{team}/products", headers=alice.headers).json()["items"]
    assert len(goods) == 1
    assert goods[0]["prices"][0]["price"] == 95_00


def test_punctuation_names_never_merge_unrelated_goods(client, team, alice):
    shop = _shop(client, team, alice, "Lenta")
    response = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Shop",
            "payer_id": alice.id,
            "spent_at": str(TODAY),
            "split_mode": "items",
            "shop_id": shop["id"],
            "items": [
                {
                    "name": "Bread",
                    "total": 50,
                    "product_name": "-",
                    "shares": [{"user_id": alice.id}],
                },
                {
                    "name": "Salt",
                    "total": 30,
                    "product_name": "...",
                    "shares": [{"user_id": alice.id}],
                },
            ],
        },
        headers=alice.headers,
    )
    assert response.status_code == 201, response.text
    bread, salt = response.json()["items"]
    assert bread["product_id"] != salt["product_id"]
    names = {
        g["name"]
        for g in client.get(f"/api/teams/{team}/products", headers=alice.headers).json()["items"]
    }
    assert names == {"Bread", "Salt"}


def test_long_printed_shop_names_are_kept_as_aliases_and_match(
    client, team, alice, monkeypatch, scanning_enabled
):
    printed = "Общество с ограниченной ответственностью «Агроторг» " + "ул. Ленина, д. 1 " * 10
    shop = _shop(client, team, alice, "Пятёрочка", alias=printed)
    assert len(shop["aliases"][0]) == 120
    _install(monkeypatch, FakeParser(LEAFLET.model_copy(update={"shop_name": printed})))
    assert _scan(client, team, alice).json()["shop"]["shop_id"] == shop["id"]
