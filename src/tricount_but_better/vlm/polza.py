"""Receipt and price-list reading through Polza's OpenAI-compatible vision API."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import date

import httpx
from pydantic import ValidationError

from ..config import Settings
from .base import ParseResult, PriceListResult, ScanHints, VlmError, VlmUnavailable
from .prompt import PRICE_LIST_PROMPT, SYSTEM_PROMPT, hints_text
from .schema import PRICE_LIST_JSON_SCHEMA, RECEIPT_JSON_SCHEMA, ParsedPriceList, ParsedReceipt

API_URL = "https://polza.ai/api/v1/chat/completions"

log = logging.getLogger(__name__)


def _known(hints: ScanHints | None) -> str:
    hints = hints or ScanHints()
    return hints_text(
        [(shop.ref, shop.name, shop.aliases) for shop in hints.shops],
        [(product.ref, product.name) for product in hints.products],
        hints.kinds,
    )


class PolzaReceiptParser:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def parse(self, images: list[bytes], hints: ScanHints | None = None) -> ParseResult:
        answer = await self._ask(
            images,
            system=SYSTEM_PROMPT,
            instruction=(
                "Extract this receipt into the required JSON structure. "
                "Multiple images are pages of one receipt, in order.\n\n" + _known(hints)
            ),
            schema_name="receipt",
            schema=RECEIPT_JSON_SCHEMA,
            what="receipt",
        )
        try:
            receipt = ParsedReceipt.model_validate(json.loads(answer))
        except (TypeError, ValueError, ValidationError) as exc:
            raise VlmError("the model returned an invalid receipt") from exc
        return ParseResult(receipt=receipt, cost_usd=None, model=self._settings.vlm_model)

    async def parse_prices(
        self, images: list[bytes], hints: ScanHints | None = None, today: date | None = None
    ) -> PriceListResult:
        answer = await self._ask(
            images,
            system=PRICE_LIST_PROMPT,
            instruction=(
                "Read the prices in these images into the required JSON structure. "
                f"Today's date is {(today or date.today()).isoformat()}.\n\n" + _known(hints)
            ),
            schema_name="price_list",
            schema=PRICE_LIST_JSON_SCHEMA,
            what="price list",
        )
        try:
            prices = ParsedPriceList.model_validate(json.loads(answer))
        except (TypeError, ValueError, ValidationError) as exc:
            raise VlmError("the model returned an invalid price list") from exc
        return PriceListResult(prices=prices, cost_usd=None, model=self._settings.vlm_model)

    async def _ask(
        self,
        images: list[bytes],
        *,
        system: str,
        instruction: str,
        schema_name: str,
        schema: dict,
        what: str,
    ) -> str:
        """Send images with a structured-output schema; return the JSON text answer."""
        if not images:
            raise VlmError("no images to read")
        api_key = self._settings.effective_polza_api_key
        if not api_key:
            raise VlmUnavailable("POLZA_API_KEY is not set")

        content: list[dict] = [{"type": "text", "text": instruction}]
        for image in images:
            data = base64.b64encode(image).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{data}"},
                }
            )

        request = {
            "model": self._settings.vlm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "max_tokens": 16000,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            },
            # Streamed, tokens keep the connection busy while the model works. A
            # long receipt read in silence can outlast a gateway on the way to
            # the provider, and Polza then answers 502.
            "stream": True,
        }
        timeout = self._settings.vlm_timeout_seconds
        try:
            async with (
                # A stream that keeps trickling must still end in time.
                asyncio.timeout(timeout),
                httpx.AsyncClient(timeout=timeout) as client,
                client.stream(
                    "POST", API_URL, headers={"Authorization": f"Bearer {api_key}"}, json=request
                ) as response,
            ):
                if response.is_error:
                    await response.aread()
                    _raise_for_status(response, what)
                # A whole completion comes back as JSON; anything else is the stream.
                if "json" in response.headers.get("content-type", ""):
                    await response.aread()
                    answer, finish = _completed(response, what)
                else:
                    answer, finish = await _streamed(response, what)
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise VlmError(f"the model took too long to read this {what}") from exc
        except httpx.RequestError as exc:
            raise VlmUnavailable("could not reach Polza API") from exc

        if finish == "length":
            raise VlmError("the model response was cut off")
        if finish == "content_filter":
            raise VlmError("the model declined to read this image")
        if finish == "error":
            raise VlmError("Polza API error")
        if not isinstance(answer, str) or not answer.strip():
            raise VlmError("the model returned an empty response")
        return answer


def _raise_for_status(response: httpx.Response, what: str) -> None:
    # Polza's reason goes to the server log only: an error body can echo the
    # request, so the user sees just the status.
    log.warning(
        "Polza %s request failed (%s): %s", what, response.status_code, response.text[:2000]
    )
    if response.status_code in (401, 403):
        raise VlmUnavailable("the Polza API key was rejected")
    if response.status_code == 429:
        raise VlmError("rate limited by Polza; try again shortly")
    raise VlmError(f"Polza API error ({response.status_code})")


def _completed(response: httpx.Response, what: str) -> tuple[object, str | None]:
    """The answer and finish reason of a whole, unstreamed completion."""
    try:
        choice = response.json()["choices"][0]
        return choice["message"]["content"], choice.get("finish_reason")
    except (AttributeError, KeyError, IndexError, TypeError, ValueError) as exc:
        raise VlmError(f"the model returned an invalid {what}") from exc


async def _streamed(response: httpx.Response, what: str) -> tuple[str, str | None]:
    """The answer and finish reason of a streamed completion, from its content
    deltas. Reasoning deltas are skipped; a provider failing mid-answer sends an
    error chunk instead of an HTTP status."""
    parts: list[str] = []
    finish = None
    async for line in response.aiter_lines():
        # Blank lines separate events; ": ..." lines are keep-alive comments.
        if not line.startswith("data:"):
            continue
        data = line.removeprefix("data:").strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
            if chunk.get("error"):
                log.warning("Polza %s stream failed: %s", what, data[:2000])
                code = chunk["error"].get("code")
                status = f" ({code})" if isinstance(code, int) else ""
                raise VlmError(f"Polza API error{status}")
            for choice in chunk.get("choices") or []:
                content = (choice.get("delta") or {}).get("content")
                if isinstance(content, str):
                    parts.append(content)
                finish = choice.get("finish_reason") or finish
        except (AttributeError, TypeError, ValueError) as exc:
            raise VlmError(f"the model returned an invalid {what}") from exc
    return "".join(parts), finish
