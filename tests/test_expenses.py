"""Expense creation, splitting, and the invariants the ledger relies on."""

from __future__ import annotations

import pytest


def _post(client, team, alice, **overrides):
    body = {
        "title": "Groceries",
        "payer_id": alice.id,
        "spent_at": "2026-09-01",
        "total": 300_00,
        "shares": [{"user_id": alice.id}],
    }
    body.update(overrides)
    return client.post(f"/api/teams/{team}/expenses", json=body, headers=alice.headers)


def test_even_split_across_everyone(client, team, alice, bob, carol) -> None:
    created = _post(
        client,
        team,
        alice,
        total=300_00,
        shares=[{"user_id": a.id} for a in (alice, bob, carol)],
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert sum(s["amount"] for s in body["shares"]) == 300_00
    assert {s["amount"] for s in body["shares"]} == {100_00}


def test_indivisible_total_still_balances(client, team, alice, bob, carol) -> None:
    created = _post(
        client, team, alice, total=100, shares=[{"user_id": a.id} for a in (alice, bob, carol)]
    )
    amounts = sorted(s["amount"] for s in created.json()["shares"])
    assert sum(amounts) == 100
    assert amounts == [33, 33, 34]


def test_weighted_split(client, team, alice, bob, carol) -> None:
    created = _post(
        client,
        team,
        alice,
        total=400_00,
        shares=[
            {"user_id": alice.id, "weight": "2"},
            {"user_id": bob.id, "weight": "1"},
            {"user_id": carol.id, "weight": "1"},
        ],
    )
    by_user = {s["user_id"]: s["amount"] for s in created.json()["shares"]}
    assert by_user[alice.id] == 200_00
    assert by_user[bob.id] == 100_00
    assert sum(by_user.values()) == 400_00


def test_split_between_only_some_people(client, team, alice, bob, carol) -> None:
    created = _post(
        client,
        team,
        alice,
        total=250_00,
        shares=[{"user_id": alice.id}, {"user_id": bob.id}],
    )
    by_user = {s["user_id"]: s["amount"] for s in created.json()["shares"]}
    assert carol.id not in by_user
    assert by_user[alice.id] == 125_00


def test_per_item_split_excludes_the_vegetarian(client, team, alice, bob, carol) -> None:
    """The scenario the app exists for: Carol does not eat chicken.

    Chicken is split between Alice and Bob only; napkins are split three ways.
    """
    created = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Pyaterochka",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "split_mode": "items",
            "items": [
                {
                    "name": "Chicken",
                    "total": 300_00,
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                },
                {
                    "name": "Napkins",
                    "total": 90_00,
                    "shares": [{"user_id": a.id} for a in (alice, bob, carol)],
                },
            ],
        },
        headers=alice.headers,
    )
    assert created.status_code == 201, created.text
    body = created.json()

    assert body["total"] == 390_00  # derived from the lines, not supplied
    by_user = {s["user_id"]: s["amount"] for s in body["shares"]}
    assert by_user[carol.id] == 30_00  # napkins only
    assert by_user[alice.id] == 180_00  # 150 chicken + 30 napkins
    assert by_user[bob.id] == 180_00
    assert sum(by_user.values()) == body["total"]


def test_item_split_balances_on_awkward_amounts(client, team, alice, bob, carol) -> None:
    created = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Corner shop",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "split_mode": "items",
            "items": [
                {
                    "name": "Chicken",
                    "total": 300_01,
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                },
                {
                    "name": "Napkins",
                    "total": 100_01,
                    "shares": [{"user_id": a.id} for a in (alice, bob, carol)],
                },
            ],
        },
        headers=alice.headers,
    )
    body = created.json()
    assert body["total"] == 400_02
    assert sum(s["amount"] for s in body["shares"]) == body["total"]


def test_editing_an_expense_rewrites_its_shares(client, team, alice, bob, carol) -> None:
    expense_id = _post(
        client, team, alice, total=300_00, shares=[{"user_id": a.id} for a in (alice, bob, carol)]
    ).json()["id"]

    updated = client.put(
        f"/api/teams/{team}/expenses/{expense_id}",
        json={
            "title": "Groceries (fixed)",
            "payer_id": bob.id,
            "spent_at": "2026-09-02",
            "total": 200_00,
            "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
        },
        headers=alice.headers,
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["payer_id"] == bob.id
    assert len(body["shares"]) == 2
    assert sum(s["amount"] for s in body["shares"]) == 200_00

    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    assert sum(b["net"] for b in balances["balances"]) == 0


def test_switching_to_item_mode_drops_the_old_shares(client, team, alice, bob, carol) -> None:
    expense_id = _post(
        client, team, alice, total=300_00, shares=[{"user_id": a.id} for a in (alice, bob, carol)]
    ).json()["id"]

    updated = client.put(
        f"/api/teams/{team}/expenses/{expense_id}",
        json={
            "title": "Now itemised",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "split_mode": "items",
            "items": [{"name": "Only thing", "total": 50_00, "shares": [{"user_id": bob.id}]}],
        },
        headers=alice.headers,
    )
    body = updated.json()
    assert body["total"] == 50_00
    assert len(body["shares"]) == 1
    assert body["shares"][0]["user_id"] == bob.id


def test_deleting_an_expense_restores_balance(client, team, alice, bob, carol) -> None:
    expense_id = _post(
        client, team, alice, total=300_00, shares=[{"user_id": a.id} for a in (alice, bob, carol)]
    ).json()["id"]
    assert (
        client.delete(f"/api/teams/{team}/expenses/{expense_id}", headers=alice.headers).status_code
        == 204
    )

    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    assert all(b["net"] == 0 for b in balances["balances"])
    assert balances["total_spend"] == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"total": None, "shares": []},
        {"split_mode": "items", "items": []},
        {"shares": [{"user_id": "11111111-1111-1111-1111-111111111111"}]},
        {"payer_id": "11111111-1111-1111-1111-111111111111"},
    ],
)
def test_invalid_expenses_are_refused(client, team, alice, overrides) -> None:
    assert _post(client, team, alice, **overrides).status_code == 422


def test_an_item_needs_someone_to_pay_for_it(client, team, alice) -> None:
    refused = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Orphan line",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "split_mode": "items",
            "items": [{"name": "Nobody's", "total": 10_00, "shares": []}],
        },
        headers=alice.headers,
    )
    assert refused.status_code == 422


def test_listing_filters_and_paginates(client, team, alice, bob) -> None:
    for i in range(5):
        _post(
            client,
            team,
            alice,
            title=f"Item {i}",
            payer_id=(alice if i % 2 else bob).id,
            shares=[{"user_id": alice.id}],
        )
    listed = client.get(f"/api/teams/{team}/expenses?limit=2", headers=alice.headers).json()
    assert listed["total_count"] == 5
    assert len(listed["items"]) == 2

    mine = client.get(f"/api/teams/{team}/expenses?payer_id={bob.id}", headers=alice.headers).json()
    assert mine["total_count"] == 3

    found = client.get(f"/api/teams/{team}/expenses?q=Item 3", headers=alice.headers).json()
    assert found["total_count"] == 1


def test_category_totals(client, team, alice) -> None:
    categories = client.get(f"/api/teams/{team}/categories", headers=alice.headers).json()
    groceries = next(c for c in categories if c["name"] == "Groceries")
    _post(client, team, alice, total=100_00, category_id=groceries["id"])
    _post(client, team, alice, total=50_00)

    totals = client.get(f"/api/teams/{team}/category-totals", headers=alice.headers).json()
    by_name = {t["name"]: t["total"] for t in totals}
    assert by_name["Groceries"] == 100_00
    assert by_name["Uncategorised"] == 50_00
