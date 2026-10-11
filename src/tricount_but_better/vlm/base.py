"""Provider-agnostic receipt parsing interface."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Protocol, runtime_checkable

from .schema import ParsedPriceList, ParsedReceipt


class VlmError(RuntimeError):
    """Parsing failed. The message is safe to show a user."""


class VlmUnavailable(VlmError):
    """The provider is not configured or cannot be reached."""


@dataclass(slots=True)
class KnownShop:
    """A shop the team already has, for the model to recognise on the receipt."""

    ref: str  # short id the model answers with, e.g. "s3" -- not the database id
    name: str
    aliases: list[str] = field(default_factory=list)


@dataclass(slots=True)
class KnownProduct:
    ref: str  # e.g. "p12"
    name: str


@dataclass(slots=True)
class ScanHints:
    """What the team already knows, so the model can match instead of guess.

    Short refs stand in for UUIDs: a small model copies "s3" reliably, and the
    caller maps it back, so an invented id can never reach the database.
    """

    shops: list[KnownShop] = field(default_factory=list)
    products: list[KnownProduct] = field(default_factory=list)


@dataclass(slots=True)
class ParseResult:
    receipt: ParsedReceipt
    cost_usd: Decimal | None = None
    model: str | None = None


@dataclass(slots=True)
class PriceListResult:
    prices: ParsedPriceList
    cost_usd: Decimal | None = None
    model: str | None = None


@runtime_checkable
class ReceiptParser(Protocol):
    async def parse(self, images: list[bytes], hints: ScanHints | None = None) -> ParseResult: ...

    async def parse_prices(
        self, images: list[bytes], hints: ScanHints | None = None, today: date | None = None
    ) -> PriceListResult:
        """Read a shop's prices -- an app, a website, a leaflet, shelf tags."""
        ...
