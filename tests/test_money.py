"""The split must never lose or invent a kopeck."""

from __future__ import annotations

from decimal import Decimal

import pytest

from tricount_but_better.money import (
    MoneyError,
    equal_split,
    exponent_for,
    split_amount,
    to_major,
    to_minor,
)


@pytest.mark.parametrize(
    ("total", "people"),
    [(100, 3), (1, 3), (0, 4), (999_999, 7), (1234567, 11), (5, 2)],
)
def test_equal_split_is_exact(total: int, people: int) -> None:
    keys = [f"u{i}" for i in range(people)]
    shares = equal_split(total, keys)
    assert sum(shares.values()) == total
    assert len(shares) == people
    # Nobody is more than one minor unit away from anyone else.
    assert max(shares.values()) - min(shares.values()) <= 1


def test_weighted_split_is_exact_and_proportional() -> None:
    shares = split_amount(1000, {"a": Decimal(1), "b": Decimal(2), "c": Decimal(1)})
    assert sum(shares.values()) == 1000
    assert shares["b"] > shares["a"]


def test_zero_weight_participant_pays_nothing() -> None:
    shares = split_amount(900, {"a": Decimal(1), "b": Decimal(0), "c": Decimal(2)})
    assert shares["b"] == 0
    assert sum(shares.values()) == 900


def test_refund_splits_symmetrically() -> None:
    shares = equal_split(-100, ["a", "b", "c"])
    assert sum(shares.values()) == -100
    assert all(v <= 0 for v in shares.values())


def test_split_is_deterministic() -> None:
    weights = {"a": Decimal(1), "b": Decimal(1), "c": Decimal(1)}
    assert split_amount(100, weights) == split_amount(100, weights)


def test_rejects_unusable_weights() -> None:
    with pytest.raises(MoneyError):
        split_amount(100, {})
    with pytest.raises(MoneyError):
        split_amount(100, {"a": Decimal(0)})
    with pytest.raises(MoneyError):
        split_amount(100, {"a": Decimal(-1)})


def test_minor_unit_conversion_round_trips() -> None:
    assert to_minor("1234.56", "RUB") == 123456
    assert to_minor("1234.565", "RUB") == 123457  # half-up, not banker's
    assert to_minor("10", "JPY") == 10
    assert exponent_for("JPY") == 0
    assert to_major(123456, "RUB") == Decimal("1234.56")


def test_rejects_nonsense_amounts() -> None:
    for bad in ("abc", "nan", "inf"):
        with pytest.raises(MoneyError):
            to_minor(bad, "RUB")
