"""Net balances and debt simplification.

The pure functions here take plain dicts so they can be unit-tested without a
database; the router layer feeds them rows.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Expense, ExpenseShare, Settlement


@dataclass(frozen=True, slots=True)
class Transfer:
    """One suggested payback: ``from_user`` should hand ``to_user`` ``amount``."""

    from_user: uuid.UUID
    to_user: uuid.UUID
    amount: int


def net_from_rows(
    payments: list[tuple[uuid.UUID, int]],
    debts: list[tuple[uuid.UUID, int]],
    settlements: list[tuple[uuid.UUID, uuid.UUID, int]],
) -> dict[uuid.UUID, int]:
    """Net position per user: positive means the group owes them.

    ``payments`` are (payer, amount) pairs, ``debts`` are (consumer, amount)
    pairs, ``settlements`` are (from_user, to_user, amount) triples. Paying
    someone back raises your net and lowers theirs, which is what retires a debt.
    """
    net: dict[uuid.UUID, int] = {}
    for user_id, amount in payments:
        net[user_id] = net.get(user_id, 0) + amount
    for user_id, amount in debts:
        net[user_id] = net.get(user_id, 0) - amount
    for from_user, to_user, amount in settlements:
        net[from_user] = net.get(from_user, 0) + amount
        net[to_user] = net.get(to_user, 0) - amount
    return net


def simplify_debts(net: dict[uuid.UUID, int]) -> list[Transfer]:
    """Reduce a net-balance map to a short list of who-pays-whom.

    Greedy largest-debtor against largest-creditor. This yields at most
    ``n - 1`` transfers, which is the practical target; finding the true
    minimum is NP-hard and not worth it for a flat-share.
    """
    creditors = sorted(((u, a) for u, a in net.items() if a > 0), key=lambda p: (-p[1], str(p[0])))
    debtors = sorted(((u, -a) for u, a in net.items() if a < 0), key=lambda p: (-p[1], str(p[0])))

    transfers: list[Transfer] = []
    i = j = 0
    # Mutable running amounts so we can partially consume either side.
    cred = [[u, a] for u, a in creditors]
    debt = [[u, a] for u, a in debtors]

    while i < len(debt) and j < len(cred):
        pay = min(debt[i][1], cred[j][1])
        if pay > 0:
            transfers.append(Transfer(from_user=debt[i][0], to_user=cred[j][0], amount=pay))
        debt[i][1] -= pay
        cred[j][1] -= pay
        if debt[i][1] == 0:
            i += 1
        if cred[j][1] == 0:
            j += 1

    return transfers


def team_net(session: Session, team_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Net balance per user for one team, read straight from the ledger tables."""
    payments = list(
        session.execute(
            select(Expense.payer_id, Expense.total).where(Expense.team_id == team_id)
        ).all()
    )
    debts = list(
        session.execute(
            select(ExpenseShare.user_id, ExpenseShare.amount)
            .join(Expense, Expense.id == ExpenseShare.expense_id)
            .where(Expense.team_id == team_id)
        ).all()
    )
    settlements = list(
        session.execute(
            select(Settlement.from_user_id, Settlement.to_user_id, Settlement.amount).where(
                Settlement.team_id == team_id
            )
        ).all()
    )
    return net_from_rows(
        [(r[0], r[1]) for r in payments],
        [(r[0], r[1]) for r in debts],
        [(r[0], r[1], r[2]) for r in settlements],
    )
