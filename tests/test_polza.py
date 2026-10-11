"""The Polza adapter sends images in order and validates the returned receipt."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from tricount_but_better.config import Settings
from tricount_but_better.vlm import (
    KnownProduct,
    KnownShop,
    ScanHints,
    VlmError,
    VlmUnavailable,
    get_parser,
    polza,
)


@pytest.mark.asyncio
async def test_polza_receipt_request(monkeypatch: pytest.MonkeyPatch) -> None:
    first = b"first image"
    second = b"second image"
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(
                                {
                                    "merchant": "Shop",
                                    "purchased_at": "2026-09-01T14:32:00",
                                    "items": [{"name": "Milk", "total": "104.50"}],
                                    "total": "104.50",
                                }
                            )
                        },
                    }
                ]
            },
        )

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(answer), **kwargs),
    )

    parser = get_parser(Settings(polza_api_key="test-key"))
    result = await parser.parse([first, second])

    assert result.receipt.merchant == "Shop"
    assert result.receipt.purchased_at.isoformat() == "2026-09-01"
    assert str(result.receipt.items[0].total) == "104.50"
    assert result.model == "qwen/qwen3.5-9b"
    assert len(seen) == 1
    request = seen[0]
    assert str(request.url) == polza.API_URL
    assert request.headers["authorization"] == "Bearer test-key"
    body = json.loads(request.content)
    assert body["model"] == "qwen/qwen3.5-9b"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert "merchant" in body["response_format"]["json_schema"]["schema"]["required"]
    assert body["response_format"]["json_schema"]["schema"]["properties"]["items"]
    images = body["messages"][1]["content"][1:]
    assert images == [
        {
            "type": "image_url",
            "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(first).decode()},
        },
        {
            "type": "image_url",
            "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(second).decode()},
        },
    ]


@pytest.mark.asyncio
async def test_polza_requires_key() -> None:
    parser = get_parser(Settings(polza_api_key=None))
    with pytest.raises(VlmUnavailable, match="POLZA_API_KEY"):
        await parser.parse([b"image"])


def test_polza_key_file_works_with_legacy_disabled_flag(tmp_path, monkeypatch) -> None:
    key_file = tmp_path / "polza_api_key"
    key_file.write_text("test-key\n", encoding="utf-8")
    monkeypatch.setenv("VLM_PROVIDER", "disabled")
    settings = Settings(polza_api_key=None, polza_api_key_file=key_file)
    assert settings.effective_polza_api_key == "test-key"
    assert get_parser(settings).__class__.__name__ == "PolzaReceiptParser"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    [(401, VlmUnavailable), (429, VlmError), (500, VlmError)],
)
async def test_polza_errors_do_not_expose_response(
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    expected: type[Exception],
) -> None:
    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(status, text="secret request contents")
            ),
            **kwargs,
        ),
    )

    parser = get_parser(Settings(polza_api_key="test-key"))
    with pytest.raises(expected) as caught:
        await parser.parse([b"image"])
    assert "secret request contents" not in str(caught.value)


@pytest.mark.asyncio
async def test_polza_lists_known_shops_and_goods_and_reads_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        content = {
            "merchant": 'ООО "Агроторг"',
            "shop_name": "Пятёрочка",
            "shop_address": " ",
            "shop_id": "s1",
            "items": [
                {
                    "name": "МОЛ ПРОСТОКВ 2,5%",
                    "total": "79.90",
                    "product_name": "Молоко Простоквашино 2,5%",
                    "product_id": "p1",
                    "discounted": True,
                    "regular_price": "99,90",
                }
            ],
        }
        return httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]
            },
        )

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(answer), **kwargs),
    )
    hints = ScanHints(
        shops=[KnownShop(ref="s1", name="Пятёрочка", aliases=['ООО "Агроторг"'])],
        products=[KnownProduct(ref="p1", name="Молоко Простоквашино 2,5% 930 мл")],
    )
    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"], hints)

    text = seen[0]["messages"][1]["content"][0]["text"]
    assert 's1: Пятёрочка; ООО "Агроторг"' in text
    assert "p1: Молоко Простоквашино 2,5% 930 мл" in text
    schema = seen[0]["response_format"]["json_schema"]["schema"]
    assert {"shop_name", "shop_id"} <= set(schema["required"])
    assert {"product_id", "discounted"} <= set(schema["properties"]["items"]["items"]["required"])

    receipt = result.receipt
    assert (receipt.shop_name, receipt.shop_id, receipt.shop_address) == ("Пятёрочка", "s1", None)
    item = receipt.items[0]
    assert (item.product_id, item.discounted, str(item.regular_price)) == ("p1", True, "99.90")


@pytest.mark.asyncio
async def test_polza_says_when_nothing_is_known_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        content = {"items": [{"name": "Milk", "total": "1"}]}
        return httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]
            },
        )

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(answer), **kwargs),
    )
    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])
    text = seen[0]["messages"][1]["content"][0]["text"]
    assert "Known shops: none yet" in text
    assert "Known products: none yet" in text
    assert result.receipt.items[0].discounted is False


@pytest.mark.asyncio
async def test_polza_reads_a_price_list_with_todays_date(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import date

    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        content = {
            "shop_name": "Лента",
            "shop_address": None,
            "shop_id": "s1",
            "currency": "rub",
            "items": [
                {
                    "name": "Кофе 1кг",
                    "product_name": "Кофе в зёрнах 1 кг",
                    "product_id": None,
                    "price": "1 199,00",
                    "regular_price": "1599.00",
                    "sale_until": "2026-10-20",
                },
                {
                    "name": "Чай",
                    "product_name": None,
                    "product_id": None,
                    "price": "?",
                    "regular_price": None,
                    "sale_until": "soon",
                },
            ],
            "notes": None,
        }
        return httpx.Response(
            200,
            json={
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]
            },
        )

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(answer), **kwargs),
    )
    hints = ScanHints(shops=[KnownShop(ref="s1", name="Лента")])
    result = await get_parser(Settings(polza_api_key="test-key")).parse_prices(
        [b"image"], hints, date(2026, 10, 11)
    )

    body = seen[0]
    assert body["response_format"]["json_schema"]["name"] == "price_list"
    assert (
        "price"
        in body["response_format"]["json_schema"]["schema"]["properties"]["items"]["items"][
            "required"
        ]
    )
    text = body["messages"][1]["content"][0]["text"]
    assert "Today's date is 2026-10-11." in text
    assert "s1: Лента" in text
    assert "price tags" in body["messages"][0]["content"]

    prices = result.prices
    assert (prices.shop_name, prices.shop_id, prices.currency) == ("Лента", "s1", "RUB")
    coffee, tea = prices.items
    assert (str(coffee.price), str(coffee.regular_price)) == ("1199.00", "1599.00")
    assert coffee.sale_until == date(2026, 10, 20)
    assert (tea.price, tea.sale_until) == (None, None)
