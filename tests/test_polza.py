"""The Polza adapter sends images in order and validates the returned receipt."""

from __future__ import annotations

import base64
import json
from decimal import Decimal

import httpx
import pytest

from tricount_but_better.config import Settings
from tricount_but_better.vlm import (
    KnownProduct,
    KnownShop,
    ParsedItem,
    ScanHints,
    VlmError,
    VlmUnavailable,
    get_parser,
    polza,
)
from tricount_but_better.vlm.schema import (
    MAX_UNION_FIELDS,
    PRICE_LIST_JSON_SCHEMA,
    RECEIPT_JSON_SCHEMA,
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
    assert result.model == "qwen/qwen3.8-omni-flash"
    assert len(seen) == 1
    request = seen[0]
    assert str(request.url) == polza.API_URL
    assert request.headers["authorization"] == "Bearer test-key"
    body = json.loads(request.content)
    assert body["model"] == "qwen/qwen3.8-omni-flash"
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


def test_agent_sdk_model_left_in_the_environment_falls_back_to_the_default(monkeypatch) -> None:
    monkeypatch.setenv("VLM_MODEL", "claude-sonnet-5")
    assert Settings().vlm_model == "qwen/qwen3.8-omni-flash"
    monkeypatch.setenv("VLM_MODEL", "anthropic/claude-sonnet-5")
    assert Settings().vlm_model == "anthropic/claude-sonnet-5"


def _union_fields(node: object) -> int:
    if isinstance(node, list):
        return sum(_union_fields(item) for item in node)
    if not isinstance(node, dict):
        return 0
    own = isinstance(node.get("type"), list) or "anyOf" in node
    return own + sum(_union_fields(value) for value in node.values())


@pytest.mark.parametrize("schema", [RECEIPT_JSON_SCHEMA, PRICE_LIST_JSON_SCHEMA])
def test_schemas_stay_within_the_structured_output_union_limit(schema: dict) -> None:
    assert _union_fields(schema) <= MAX_UNION_FIELDS


def test_empty_levels_read_as_none() -> None:
    item = ParsedItem.model_validate(
        {
            "name": "БАНАНЫ",
            "kind": "бананы",
            "variety": "",
            "brand": " ",
            "size_amount": "",
            "size_unit": "",
            "by_weight": True,
            "total": "89.90",
        }
    )
    assert (item.kind, item.variety, item.brand) == ("бананы", None, None)
    assert (item.size_amount, item.size_unit, item.by_weight) == (None, None, True)


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


def _sse(*chunks: dict | str) -> httpx.Response:
    """A streamed completion: each chunk as a server-sent event, then [DONE]."""
    events = [chunk if isinstance(chunk, str) else f"data: {json.dumps(chunk)}" for chunk in chunks]
    body = "\n\n".join([*events, "data: [DONE]"]) + "\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)


def _delta(content: str | None = None, finish: str | None = None, **delta: str) -> dict:
    if content is not None:
        delta["content"] = content
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


def _stream_into(monkeypatch: pytest.MonkeyPatch, response: httpx.Response, seen: list) -> None:
    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return response

    client_type = httpx.AsyncClient
    monkeypatch.setattr(
        polza.httpx,
        "AsyncClient",
        lambda **kwargs: client_type(transport=httpx.MockTransport(answer), **kwargs),
    )


@pytest.mark.asyncio
async def test_polza_streams_and_joins_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    receipt = json.dumps({"merchant": "Shop", "items": [{"name": "Milk", "total": "104.50"}]})
    seen: list = []
    _stream_into(
        monkeypatch,
        _sse(
            ": OPENROUTER PROCESSING",
            _delta(reasoning="Reading the lines first."),
            _delta(receipt[:20]),
            _delta(receipt[20:]),
            _delta("", finish="stop"),
        ),
        seen,
    )

    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])

    assert seen[0]["stream"] is True
    assert result.receipt.merchant == "Shop"
    assert str(result.receipt.items[0].total) == "104.50"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "message"),
    [
        (
            [_delta('{"items": ['), {"error": {"code": 502, "message": "Provider disconnected"}}],
            r"Polza API error \(502\)",
        ),
        ([_delta('{"items": ['), _delta("", finish="error")], "Polza API error"),
        ([_delta('{"items": ['), _delta("", finish="length")], "cut off"),
        ([_delta("", finish="stop")], "empty response"),
    ],
)
async def test_polza_stream_failures(
    monkeypatch: pytest.MonkeyPatch, chunks: list, message: str
) -> None:
    _stream_into(monkeypatch, _sse(*chunks), [])

    with pytest.raises(VlmError, match=message) as caught:
        await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])
    assert "Provider disconnected" not in str(caught.value)


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
                    "kind": " молоко ",
                    "variety": "2,5%",
                    "brand": "",
                    "size_amount": "0,93",
                    "size_unit": "l",
                    "by_weight": "false",
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
        kinds=["молоко", "хлеб"],
    )
    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"], hints)

    text = seen[0]["messages"][1]["content"][0]["text"]
    assert 's1: Пятёрочка; ООО "Агроторг"' in text
    assert "p1: Молоко Простоквашино 2,5% 930 мл" in text
    assert "Kinds the team already uses: молоко; хлеб" in text
    schema = seen[0]["response_format"]["json_schema"]["schema"]
    assert {"shop_name", "shop_id"} <= set(schema["required"])
    line = schema["properties"]["items"]["items"]
    assert {"product_id", "discounted", "kind", "size_unit", "by_weight"} <= set(line["required"])
    # The levels come right after the printed name, before the readable one.
    order = list(line["properties"])
    assert order.index("name") < order.index("kind") < order.index("product_name")

    receipt = result.receipt
    assert (receipt.shop_name, receipt.shop_id, receipt.shop_address) == ("Пятёрочка", "s1", None)
    item = receipt.items[0]
    assert (item.product_id, item.discounted, str(item.regular_price)) == ("p1", True, "99.90")
    assert (item.kind, item.variety, item.brand) == ("молоко", "2,5%", None)
    assert (item.size_amount, item.size_unit, item.by_weight) == (Decimal("0.93"), "l", False)


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
