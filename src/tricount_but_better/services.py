"""Write-side logic that keeps the ledger self-consistent.

The invariant every function here protects: for any expense,
``sum(share.amount for share in expense.shares) == expense.total``.
Balance queries depend on it and never re-derive it.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from decimal import Decimal

from .models import Expense, ExpenseShare, ItemShare, SplitMode
from .money import MoneyError, split_amount


class SplitError(ValueError):
    """The requested split cannot be applied as given."""


def apply_total_split(expense: Expense, weights: dict[uuid.UUID, Decimal]) -> None:
    """Split the expense total across ``weights`` and replace its share rows."""
    if not weights:
        raise SplitError("an expense needs at least one participant")
    try:
        amounts = split_amount(expense.total, weights)
    except MoneyError as exc:
        raise SplitError(str(exc)) from exc

    expense.split_mode = SplitMode.total
    expense.shares = [
        ExpenseShare(user_id=user_id, weight=weights[user_id], amount=amount)
        for user_id, amount in amounts.items()
    ]


def apply_item_splits(expense: Expense) -> None:
    """Price each line from its own participant weights, then roll up.

    ``expense.total`` is recomputed as the sum of the lines: a receipt's printed
    grand total is a claim to show the user, not something the ledger trusts.
    """
    if not expense.items:
        raise SplitError("an itemised expense needs at least one line")

    rollup: dict[uuid.UUID, int] = defaultdict(int)
    for item in expense.items:
        if not item.shares:
            raise SplitError(f"nobody is assigned to '{item.name}'")
        weights = {share.user_id: share.weight for share in item.shares}
        try:
            amounts = split_amount(item.total, weights)
        except MoneyError as exc:
            raise SplitError(f"'{item.name}': {exc}") from exc
        for share in item.shares:
            share.amount = amounts[share.user_id]
            rollup[share.user_id] += share.amount

    expense.split_mode = SplitMode.items
    expense.total = sum(item.total for item in expense.items)
    expense.shares = [
        ExpenseShare(user_id=user_id, weight=None, amount=amount)
        for user_id, amount in rollup.items()
    ]


def build_item_shares(
    weights: dict[uuid.UUID, Decimal],
) -> list[ItemShare]:
    """Fresh, unpriced share rows for one line; amounts are filled by the rollup."""
    if not weights:
        raise SplitError("each line needs at least one participant")
    return [ItemShare(user_id=user_id, weight=weight) for user_id, weight in weights.items()]


def assert_balanced(expense: Expense) -> None:
    """Defensive check used by tests and by the write paths."""
    total = sum(share.amount for share in expense.shares)
    if total != expense.total:
        raise SplitError(f"shares sum to {total} but the expense total is {expense.total}")
