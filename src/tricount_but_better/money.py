"""Exact money arithmetic.

Every amount in this application is an ``int`` in *minor units* (kopecks,
cents...). Floats never touch a monetary value. The one rule that matters:
a split must sum back to exactly the amount that was split.
"""

from __future__ import annotations

from collections.abc import Hashable
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import TypeVar

K = TypeVar("K", bound=Hashable)

# Currencies whose minor unit is not 1/100.
_EXPONENTS: dict[str, int] = {
    "JPY": 0,
    "KRW": 0,
    "VND": 0,
    "CLP": 0,
    "ISK": 0,
    "BHD": 3,
    "KWD": 3,
    "OMR": 3,
    "TND": 3,
}
DEFAULT_EXPONENT = 2


class MoneyError(ValueError):
    """Raised when an amount or a set of split weights is not usable."""


def exponent_for(currency: str) -> int:
    return _EXPONENTS.get(currency.upper(), DEFAULT_EXPONENT)


def to_minor(amount: Decimal | str | int, currency: str) -> int:
    """Convert a human amount ("1234.56") to minor units (123456)."""
    try:
        dec = Decimal(str(amount))
    except (InvalidOperation, ValueError) as exc:
        raise MoneyError(f"not a valid amount: {amount!r}") from exc
    if not dec.is_finite():
        raise MoneyError(f"not a finite amount: {amount!r}")
    scale = Decimal(10) ** exponent_for(currency)
    return int((dec * scale).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_major(minor: int, currency: str) -> Decimal:
    """Convert minor units back to a human amount, for display/serialisation."""
    exp = exponent_for(currency)
    return (Decimal(minor) / (Decimal(10) ** exp)).quantize(Decimal(1).scaleb(-exp))


def split_amount[K: Hashable](total: int, weights: dict[K, Decimal]) -> dict[K, int]:
    """Split ``total`` minor units across ``weights``, proportionally and exactly.

    Uses the largest-remainder method, so ``sum(result.values()) == total`` holds
    for every input -- including the cases that make naive rounding leak a
    kopeck, such as splitting 100 three ways.

    Leftover units go to the largest fractional remainders first; ties break on
    insertion order of ``weights``, which makes the result deterministic and
    therefore safe to recompute on every read.
    """
    if not weights:
        raise MoneyError("cannot split across an empty set of participants")

    keys = list(weights)
    for key in keys:
        if weights[key] < 0:
            raise MoneyError(f"weight for {key!r} is negative")

    total_weight = sum(weights.values(), Decimal(0))
    if total_weight <= 0:
        raise MoneyError("total weight must be greater than zero")

    # Work on the magnitude so flooring behaves symmetrically for refunds.
    sign = -1 if total < 0 else 1
    magnitude = abs(total)

    exact = {k: Decimal(magnitude) * weights[k] / total_weight for k in keys}
    shares = {k: int(exact[k]) for k in keys}  # truncation == floor, all non-negative
    remainder = magnitude - sum(shares.values())

    # Hand out the leftover units, biggest fractional part first.
    order = sorted(
        range(len(keys)),
        key=lambda i: (-(exact[keys[i]] - int(exact[keys[i]])), i),
    )
    for i in range(remainder):
        shares[keys[order[i]]] += 1

    return {k: sign * v for k, v in shares.items()}


def equal_split[K: Hashable](total: int, keys: list[K]) -> dict[K, int]:
    """Split ``total`` evenly -- the common case, kept readable at call sites."""
    return split_amount(total, {k: Decimal(1) for k in keys})
