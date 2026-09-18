"""Provider-agnostic receipt parsing interface."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Protocol, runtime_checkable

from .schema import ParsedReceipt


class VlmError(RuntimeError):
    """Parsing failed. The message is safe to show a user."""


class VlmUnavailable(VlmError):
    """The provider is not configured or cannot be reached."""


@dataclass(slots=True)
class ParseResult:
    receipt: ParsedReceipt
    cost_usd: Decimal | None = None
    model: str | None = None


@runtime_checkable
class ReceiptParser(Protocol):
    async def parse(self, image_paths: list[Path]) -> ParseResult: ...
