"""The Polza adapter sends images in order and validates the returned receipt."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from tricount_but_better.config import Settings
from tricount_but_better.vlm import VlmError, VlmUnavailable, get_parser, polza


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
