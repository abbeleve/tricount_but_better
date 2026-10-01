"""Receipt parsing through Polza."""

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
    """Build the Polza provider."""
    from .polza import PolzaReceiptParser

    return PolzaReceiptParser(settings)
