"""Receipt parsing through Polza."""

from __future__ import annotations

from ..config import Settings
from .base import (
    KnownProduct,
    KnownShop,
    ParseResult,
    PriceListResult,
    ReceiptParser,
    ScanHints,
    VlmError,
    VlmUnavailable,
)
from .schema import ParsedItem, ParsedPrice, ParsedPriceList, ParsedReceipt

__all__ = [
    "KnownProduct",
    "KnownShop",
    "ParseResult",
    "ParsedItem",
    "ParsedPrice",
    "ParsedPriceList",
    "PriceListResult",
    "ParsedReceipt",
    "ReceiptParser",
    "ScanHints",
    "VlmError",
    "VlmUnavailable",
    "get_parser",
]


def get_parser(settings: Settings) -> ReceiptParser:
    """Build the Polza provider."""
    from .polza import PolzaReceiptParser

    return PolzaReceiptParser(settings)
