"""Receipt and price-list reading through Polza's OpenAI-compatible vision API."""

from __future__ import annotations

import base64
import json
from datetime import date

import httpx
from pydantic import ValidationError

from ..config import Settings
from .base import ParseResult, PriceListResult, ScanHints, VlmError, VlmUnavailable
from .prompt import PRICE_LIST_PROMPT, SYSTEM_PROMPT, hints_text
from .schema import PRICE_LIST_JSON_SCHEMA, RECEIPT_JSON_SCHEMA, ParsedPriceList, ParsedReceipt

API_URL = "https://polza.ai/api/v1/chat/completions"


def _known(hints: ScanHints | None) -> str:
    hints = hints or ScanHints()
    return hints_text(
        [(shop.ref, shop.name, shop.aliases) for shop in hints.shops],
        [(product.ref, product.name) for product in hints.products],
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
        }
        try:
            async with httpx.AsyncClient(timeout=self._settings.vlm_timeout_seconds) as client:
                response = await client.post(
                    API_URL,
                    headers={"Authorization": f"Bearer {api_key}"},
                    json=request,
                )
        except httpx.TimeoutException as exc:
            raise VlmError(f"the model took too long to read this {what}") from exc
        except httpx.RequestError as exc:
            raise VlmUnavailable("could not reach Polza API") from exc

        if response.status_code in (401, 403):
            raise VlmUnavailable("the Polza API key was rejected")
        if response.status_code == 429:
            raise VlmError("rate limited by Polza; try again shortly")
        if response.is_error:
            raise VlmError(f"Polza API error ({response.status_code})")

        try:
            choice = response.json()["choices"][0]
            if choice.get("finish_reason") == "length":
                raise VlmError("the model response was cut off")
            if choice.get("finish_reason") == "content_filter":
                raise VlmError("the model declined to read this image")
            answer = choice["message"]["content"]
        except (AttributeError, KeyError, IndexError, TypeError, ValueError) as exc:
            raise VlmError(f"the model returned an invalid {what}") from exc
        if not isinstance(answer, str) or not answer.strip():
            raise VlmError("the model returned an empty response")
        return answer
