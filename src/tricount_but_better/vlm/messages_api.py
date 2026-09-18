"""Receipt parsing via the Messages API, authenticated with an API key.

Escape hatch for hosts that have an ``ANTHROPIC_API_KEY``: it is cheaper per
call and easier to rate-limit than spawning a CLI, but it will not accept a
Claude Code OAuth token. Proxy and relay settings are applied to the HTTP client
so the same geo-routing options work here as in the agent provider.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import anthropic
from anthropic import AsyncAnthropic, DefaultAsyncHttpxClient

from ..config import Settings
from .base import ParseResult, VlmError, VlmUnavailable
from .prompt import SYSTEM_PROMPT
from .schema import RECEIPT_JSON_SCHEMA, ParsedReceipt

_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


class MessagesApiReceiptParser:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _client(self) -> AsyncAnthropic:
        s = self._settings
        kwargs: dict = {"api_key": s.anthropic_api_key}
        if s.anthropic_base_url:
            kwargs["base_url"] = s.anthropic_base_url
        if s.anthropic_proxy_url:
            kwargs["http_client"] = DefaultAsyncHttpxClient(proxy=s.anthropic_proxy_url)
        return AsyncAnthropic(**kwargs)

    async def parse(self, image_paths: list[Path]) -> ParseResult:
        if not image_paths:
            raise VlmError("no images to read")
        if not self._settings.anthropic_api_key:
            raise VlmUnavailable("ANTHROPIC_API_KEY is not set.")

        content: list[dict] = []
        for path in image_paths:
            media_type = _MEDIA_TYPES.get(path.suffix.lower())
            if media_type is None:
                raise VlmError(f"unsupported image type: {path.suffix}")
            data = base64.standard_b64encode(path.read_bytes()).decode("ascii")
            content.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": data},
                }
            )
        content.append(
            {
                "type": "text",
                "text": (
                    "Extract this receipt into the required structure. "
                    "Multiple images are pages of one receipt, in order."
                ),
            }
        )

        client = self._client()
        try:
            response = await client.messages.create(
                model=self._settings.vlm_model,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": content}],
                output_config={
                    "format": {
                        "type": "json_schema",
                        "name": "receipt",
                        "schema": RECEIPT_JSON_SCHEMA,
                    }
                },
            )
        except anthropic.AuthenticationError as exc:
            raise VlmUnavailable("the Anthropic API key was rejected") from exc
        except anthropic.RateLimitError as exc:
            raise VlmError("rate limited by the model provider; try again shortly") from exc
        except anthropic.APIConnectionError as exc:
            raise VlmUnavailable(
                "could not reach the model provider -- check the proxy or relay settings"
            ) from exc
        except anthropic.APIStatusError as exc:
            raise VlmError(f"model provider error ({exc.status_code})") from exc
        finally:
            await client.close()

        if response.stop_reason == "refusal":
            raise VlmError("the model declined to read this image")

        text = next((b.text for b in response.content if b.type == "text"), None)
        if not text:
            raise VlmError("the model returned an empty response")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise VlmError("the model returned malformed JSON") from exc

        return ParseResult(
            receipt=ParsedReceipt.model_validate(payload),
            cost_usd=None,
            model=self._settings.vlm_model,
        )
