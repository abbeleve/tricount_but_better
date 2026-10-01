"""Receipt parsing through Polza's OpenAI-compatible vision API."""

from __future__ import annotations

import base64
import json

import httpx
from pydantic import ValidationError

from ..config import Settings
from .base import ParseResult, VlmError, VlmUnavailable
from .prompt import SYSTEM_PROMPT
from .schema import RECEIPT_JSON_SCHEMA, ParsedReceipt

API_URL = "https://polza.ai/api/v1/chat/completions"


class PolzaReceiptParser:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def parse(self, images: list[bytes]) -> ParseResult:
        if not images:
            raise VlmError("no images to read")
        if not self._settings.polza_api_key:
            raise VlmUnavailable("POLZA_API_KEY is not set")

        content: list[dict] = [
            {
                "type": "text",
                "text": (
                    "Extract this receipt into the required JSON structure. "
                    "Multiple images are pages of one receipt, in order."
                ),
            }
        ]
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
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            "max_tokens": 16000,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "receipt",
                    "strict": True,
                    "schema": RECEIPT_JSON_SCHEMA,
                },
            },
        }
        try:
            async with httpx.AsyncClient(timeout=self._settings.vlm_timeout_seconds) as client:
                response = await client.post(
                    API_URL,
                    headers={"Authorization": f"Bearer {self._settings.polza_api_key}"},
                    json=request,
                )
        except httpx.TimeoutException as exc:
            raise VlmError("the model took too long to read this receipt") from exc
        except httpx.RequestError as exc:
            raise VlmUnavailable("could not reach Polza API") from exc

        if response.status_code in (401, 403):
            raise VlmUnavailable("the Polza API key was rejected")
        if response.status_code == 429:
            raise VlmError("rate limited by Polza; try again shortly")
        if response.is_error:
            raise VlmError(f"Polza API error ({response.status_code})")

        try:
            completion = response.json()
            choice = completion["choices"][0]
            if choice.get("finish_reason") == "length":
                raise VlmError("the model response was cut off")
            if choice.get("finish_reason") == "content_filter":
                raise VlmError("the model declined to read this image")
            answer = choice["message"]["content"]
            if not isinstance(answer, str) or not answer.strip():
                raise VlmError("the model returned an empty response")
            return ParseResult(
                receipt=ParsedReceipt.model_validate(json.loads(answer)),
                cost_usd=None,
                model=self._settings.vlm_model,
            )
        except (
            AttributeError,
            KeyError,
            IndexError,
            TypeError,
            ValueError,
            ValidationError,
        ) as exc:
            raise VlmError("the model returned an invalid receipt") from exc
