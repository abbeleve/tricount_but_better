"""Receipt parsing providers."""

from __future__ import annotations

from ..config import Settings
from .base import ParseResult, ReceiptParser, VlmError, VlmUnavailable
from .schema import ParsedItem, ParsedReceipt

__all__ = [
    "ParseResult",
    "ParsedItem",
    "ParsedReceipt",
    "ReceiptParser",
    "VlmError",
    "VlmUnavailable",
    "get_parser",
]


def get_parser(settings: Settings) -> ReceiptParser:
    """Build the configured provider.

    Raises ``VlmUnavailable`` rather than returning a broken parser, so the
    route can answer with a clear 503 instead of failing mid-upload.
    """
    if settings.vlm_provider == "agent_sdk":
        from .agent_sdk import AgentSdkReceiptParser

        return AgentSdkReceiptParser(settings)
    if settings.vlm_provider == "messages_api":
        from .messages_api import MessagesApiReceiptParser

        return MessagesApiReceiptParser(settings)
    raise VlmUnavailable("receipt scanning is disabled on this server")
