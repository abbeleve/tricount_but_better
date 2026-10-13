"""The Polza adapter sends images in order and validates the returned receipt."""

from __future__ import annotations

import base64
import json
from datetime import date
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
    PRICE_LIST_JSON_SCHEMA,
    RECEIPT_JSON_SCHEMA,
    ParsedPriceList,
    ParsedReceipt,
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


def _types(node: object) -> list:
    if isinstance(node, list):
        return [found for item in node for found in _types(item)]
    if not isinstance(node, dict):
        return []
    own = [node["type"]] if "type" in node and not isinstance(node["type"], dict) else []
    own += [node["anyOf"]] if "anyOf" in node else []
    return own + [found for value in node.values() for found in _types(value)]


@pytest.mark.parametrize("schema", [RECEIPT_JSON_SCHEMA, PRICE_LIST_JSON_SCHEMA])
def test_a_missing_value_is_an_empty_string_never_null(schema: dict) -> None:
    # One rule for the model, and no union types: Claude's structured outputs
    # allow only 16 of them per request.
    assert all(isinstance(kind, str) and kind != "null" for kind in _types(schema))


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


def _raw_stream(body: str) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=body)


@pytest.mark.asyncio
async def test_polza_stream_that_ends_mid_answer_is_not_read_as_a_bad_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No finish reason and no [DONE]: the connection closed partway through.
    body = "data: " + json.dumps(_delta('{"items": [{"name": ')) + "\n\n"
    _stream_into(monkeypatch, _raw_stream(body), [])

    with pytest.raises(VlmError, match="connection broke"):
        await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])


@pytest.mark.asyncio
async def test_polza_reads_every_providers_name_for_the_output_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stream_into(monkeypatch, _sse(_delta('{"items": ['), _delta("", finish="MAX_TOKENS")), [])

    with pytest.raises(VlmError, match="cut off"):
        await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])


RECEIPT = '{"items": [{"name": "Молоко", "total": "104.50"}]}'


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        "```json\n" + RECEIPT + "\n```",
        "<think>The total is {104.50}.</think>\n" + RECEIPT,
        "Here is the receipt:\n" + RECEIPT,
        # A raw line break or tab inside a string, which strict JSON refuses.
        RECEIPT.replace("Молоко", "Мол\nоко\t3,2%"),
    ],
)
async def test_polza_reads_json_the_schema_did_not_hold_the_model_to(
    monkeypatch: pytest.MonkeyPatch, answer: str
) -> None:
    _stream_into(monkeypatch, _sse(_delta(answer), _delta("", finish="stop")), [])

    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])

    assert str(result.receipt.items[0].total) == "104.50"


@pytest.mark.asyncio
async def test_polza_stream_keeps_unicode_line_separators_inside_an_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Written raw, as a JavaScript server's JSON.stringify leaves them, and
    # after an empty data line that must be skipped.
    answer = RECEIPT.replace("Молоко", "Мол око\u0085")
    events = [_delta(answer), _delta("", finish="stop")]
    body = "data:\n\n" + "".join(f"data: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events)
    _stream_into(monkeypatch, _raw_stream(body + "data: [DONE]\n\n"), [])

    result = await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])

    assert result.receipt.items[0].name == "Мол око"


@pytest.mark.asyncio
async def test_polza_error_in_a_whole_reply_is_reported_as_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = httpx.Response(200, json={"error": {"code": 502, "message": "secret upstream"}})
    _stream_into(monkeypatch, reply, [])

    with pytest.raises(VlmError, match=r"Polza API error \(502\)") as caught:
        await get_parser(Settings(polza_api_key="test-key")).parse([b"image"])
    assert "secret upstream" not in str(caught.value)


@pytest.mark.parametrize(
    ("written", "read"),
    [
        ("249.90", "249.90"),
        ("249,90", "249.90"),
        ("0,482", "0.482"),
        ("1 199,00", "1199.00"),
        ("1 199,00", "1199.00"),
        ("1,199.00", "1199.00"),
        ("1.199,00", "1199.00"),
        ("1,234,567", "1234567"),
        ("249.90 ₽", "249.90"),
        ("RUB 249.90", "249.90"),
        ("−50,00", "-50.00"),
        (104.5, "104.5"),
        (3, "3"),
        (Decimal("89.90"), "89.90"),
        ("", None),
        ("?", None),
        ("2 x 49.90", None),
        ("NaN", None),
        (True, None),
    ],
)
def test_amounts_are_read_the_way_models_write_them(written: object, read: str | None) -> None:
    item = ParsedItem.model_validate({"name": "A", "total": written})
    assert (str(item.total) if item.total is not None else None) == read


def test_one_unreadable_line_does_not_sink_the_receipt() -> None:
    receipt = ParsedReceipt.model_validate(
        {
            "purchased_at": "01.09.2026",
            "items": [
                {"name": "Хлеб", "total": "62.00"},
                # Kept for a person to fill in: dropping it would shorten the total.
                {"name": "Сыр", "total": "?"},
                {"name": None, "product_name": "Молоко 3,2%", "total": "104.50"},
                {"name": "", "total": None},
                "not a line",
            ],
        }
    )

    assert receipt.purchased_at == date(2026, 9, 1)
    assert [(item.name, item.total) for item in receipt.items] == [
        ("Хлеб", Decimal("62.00")),
        ("Сыр", None),
        ("Молоко 3,2%", Decimal("104.50")),
    ]
    assert receipt.items_total == Decimal("166.50")


@pytest.mark.parametrize(
    ("written", "read"),
    [
        ("2026-09-01", date(2026, 9, 1)),
        ("2026-09-01T14:32:00Z", date(2026, 9, 1)),
        ("01.09.2026 14:32", date(2026, 9, 1)),
        ("01.09.26", date(2026, 9, 1)),
        ("31.02.2026", None),
        ("unknown", None),
        (None, None),
    ],
)
def test_a_purchase_date_the_model_wrote_oddly_does_not_sink_the_receipt(
    written: object, read: date | None
) -> None:
    receipt = ParsedReceipt.model_validate({"purchased_at": written, "items": []})
    assert receipt.purchased_at == read


def test_one_unreadable_price_does_not_sink_the_list() -> None:
    prices = ParsedPriceList.model_validate(
        {"items": [{"name": "Кофе", "price": "1 199,00 ₽"}, {"name": None, "price": None}, 7]}
    )
    assert [(item.name, item.price) for item in prices.items] == [("Кофе", Decimal("1199.00"))]
