"""Spending includes the entire ledger, once, and stays private to the team."""

import uuid
from datetime import date

from sqlalchemy import insert

from tricount_but_better.models import Expense


def _add(client, team, alice, **changes):
    body = {
        "title": "Purchase",
        "payer_id": alice.id,
        "spent_at": "2026-10-01",
        "total": 101,
        "shares": [{"user_id": alice.id}],
    }
    body.update(changes)
    response = client.post(f"/api/teams/{team}/expenses", json=body, headers=alice.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _spending(client, team, actor):
    response = client.get(f"/api/teams/{team}/spending", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_empty_spending_and_membership(client, team, alice, bob):
    assert _spending(client, team, bob) == {"currency": "RUB", "days": []}
    assert client.get(f"/api/teams/{team}/spending").status_code == 401
    private = client.post(
        "/api/teams", json={"name": "Private", "currency": "JPY"}, headers=alice.headers
    ).json()["id"]
    assert _spending(client, private, alice)["currency"] == "JPY"
    assert client.get(f"/api/teams/{private}/spending", headers=bob.headers).status_code == 404


def test_spending_counts_purchase_dates_once_and_excludes_other_money(client, team, alice, bob):
    _add(client, team, alice, spent_at="2025-12-31", total=123)
    _add(client, team, alice, spent_at="2026-10-01", total=101)
    _add(client, team, alice, spent_at="2026-10-01", total=-50, title="Refund")
    _add(
        client,
        team,
        alice,
        spent_at="2024-02-29",
        split_mode="items",
        total=None,
        shares=[],
        items=[
            {"name": "A", "total": 201, "shares": [{"user_id": alice.id}, {"user_id": bob.id}]},
            {"name": "B", "total": 99, "shares": [{"user_id": bob.id}]},
        ],
    )
    # Future purchase dates remain in history for the client to filter by its local today.
    _add(client, team, alice, spent_at="2027-01-01", total=999)
    other = client.post("/api/teams", json={"name": "Other"}, headers=alice.headers).json()["id"]
    _add(client, other, alice, total=10000)
    assert (
        client.post(
            f"/api/teams/{team}/plans",
            headers=alice.headers,
            json={"title": "Later", "items": [{"name": "Plan", "total": 10000}]},
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"/api/teams/{team}/settlements",
            headers=alice.headers,
            json={
                "from_user_id": bob.id,
                "to_user_id": alice.id,
                "amount": 10000,
                "settled_at": "2026-10-01",
            },
        ).status_code
        == 201
    )
    assert _spending(client, team, bob) == {
        "currency": "RUB",
        "days": [
            {"date": "2024-02-29", "total": 300, "expense_count": 1},
            {"date": "2025-12-31", "total": 123, "expense_count": 1},
            {"date": "2026-10-01", "total": 51, "expense_count": 2},
            {"date": "2027-01-01", "total": 999, "expense_count": 1},
        ],
    }


def test_spending_is_not_truncated_by_expense_pagination(client, team, alice, session):
    session.execute(
        insert(Expense),
        [
            {
                "team_id": uuid.UUID(team),
                "payer_id": uuid.UUID(alice.id),
                "created_by_id": uuid.UUID(alice.id),
                "title": f"Purchase {i}",
                "currency": "RUB",
                "total": 7,
                "spent_at": date(2026, 9, 1),
            }
            for i in range(205)
        ],
    )
    session.commit()
    assert _spending(client, team, alice)["days"] == [
        {"date": "2026-09-01", "total": 1435, "expense_count": 205}
    ]


def test_spending_updates_after_edit_and_delete(client, team, alice):
    expense = _add(client, team, alice)
    response = client.put(
        f"/api/teams/{team}/expenses/{expense['id']}",
        headers=alice.headers,
        json={
            "title": "Corrected",
            "payer_id": alice.id,
            "spent_at": "2025-12-31",
            "total": 777,
            "shares": [{"user_id": alice.id}],
        },
    )
    assert response.status_code == 200, response.text
    assert _spending(client, team, alice)["days"] == [
        {"date": "2025-12-31", "total": 777, "expense_count": 1}
    ]
    assert (
        client.delete(
            f"/api/teams/{team}/expenses/{expense['id']}", headers=alice.headers
        ).status_code
        == 204
    )
    assert _spending(client, team, alice)["days"] == []
