"""Net balances and the who-pays-whom reduction."""

from __future__ import annotations

import uuid

from tricount_but_better.balances import net_from_rows, simplify_debts

A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()


def test_net_always_sums_to_zero() -> None:
    net = net_from_rows([(A, 149000)], [(A, 49667), (B, 49667), (C, 49666)], [])
    assert sum(net.values()) == 0
    assert net[A] == 99333


def test_settlement_retires_debt() -> None:
    net = net_from_rows([(A, 1000)], [(A, 500), (B, 500)], [(B, A, 500)])
    assert net == {A: 0, B: 0}


def test_simplify_produces_at_most_n_minus_one_transfers() -> None:
    net = {A: 99333, B: -49667, C: -49666}
    transfers = simplify_debts(net)
    assert len(transfers) <= len(net) - 1
    assert sum(t.amount for t in transfers) == 99333
    assert all(t.amount > 0 for t in transfers)


def test_settled_group_needs_no_transfers() -> None:
    assert simplify_debts({A: 0, B: 0, C: 0}) == []


def test_transfers_exactly_clear_every_balance() -> None:
    net = {A: 12345, B: -4000, C: -8345}
    residual = dict(net)
    for transfer in simplify_debts(net):
        residual[transfer.from_user] += transfer.amount
        residual[transfer.to_user] -= transfer.amount
    assert all(v == 0 for v in residual.values())
