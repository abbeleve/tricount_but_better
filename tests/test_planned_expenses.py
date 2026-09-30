"""A shopping plan stays out of the ledger until it becomes a real expense."""

from __future__ import annotations


def _url(team: str) -> str:
    return f"/api/teams/{team}/plans"


def test_plan_without_prices_does_not_change_balances(client, team, alice) -> None:
    created = client.post(
        _url(team),
        json={"title": "Weekend shop", "items": [{"name": "Bread"}, {"name": "Milk"}]},
        headers=alice.headers,
    )
    assert created.status_code == 201, created.text
    plan = created.json()
    assert [item["total"] for item in plan["items"]] == [None, None]
    assert client.get(_url(team), headers=alice.headers).json()[0]["id"] == plan["id"]

    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    assert balances["total_spend"] == 0
    assert all(person["net"] == 0 for person in balances["balances"])
    assert client.get(f"/api/teams/{team}/expenses", headers=alice.headers).json()["items"] == []


def test_plan_can_be_edited_then_completed_atomically(client, team, alice, bob) -> None:
    plan_id = client.post(
        _url(team),
        json={"title": "Supplies", "items": [{"name": "Soap"}]},
        headers=alice.headers,
    ).json()["id"]
    edited = client.put(
        f"{_url(team)}/{plan_id}",
        json={"title": "Supplies", "items": [{"name": "Soap", "total": 250_00}]},
        headers=bob.headers,
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["items"][0]["total"] == 250_00

    completed = client.post(
        f"{_url(team)}/{plan_id}/complete",
        json={
            "title": "Supplies",
            "payer_id": alice.id,
            "spent_at": "2026-10-01",
            "split_mode": "items",
            "items": [
                {
                    "name": "Soap",
                    "total": 250_00,
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                }
            ],
        },
        headers=alice.headers,
    )
    assert completed.status_code == 201, completed.text
    assert completed.json()["total"] == 250_00
    assert client.get(f"{_url(team)}/{plan_id}", headers=alice.headers).status_code == 404
    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    assert balances["total_spend"] == 250_00


def test_failed_completion_keeps_plan_and_balances(client, team, alice) -> None:
    plan_id = client.post(
        _url(team),
        json={"title": "Groceries", "items": [{"name": "Fruit"}]},
        headers=alice.headers,
    ).json()["id"]
    failed = client.post(
        f"{_url(team)}/{plan_id}/complete",
        json={
            "title": "Groceries",
            "payer_id": alice.id,
            "spent_at": "2026-10-01",
            "split_mode": "items",
            "items": [{"name": "Fruit", "shares": [{"user_id": alice.id}]}],
        },
        headers=alice.headers,
    )
    assert failed.status_code == 422
    assert client.get(f"{_url(team)}/{plan_id}", headers=alice.headers).status_code == 200
    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    assert balances["total_spend"] == 0


def test_plan_access_and_categories_are_team_scoped(client, team, alice, bob) -> None:
    plan_id = client.post(
        _url(team),
        json={"title": "Groceries", "items": [{"name": "Fruit"}]},
        headers=alice.headers,
    ).json()["id"]
    other_team = client.post("/api/teams", json={"name": "Other"}, headers=alice.headers).json()[
        "id"
    ]
    assert client.get(f"{_url(other_team)}/{plan_id}", headers=alice.headers).status_code == 404
    assert client.get(_url(other_team), headers=bob.headers).status_code == 404
    invalid = client.put(
        f"{_url(team)}/{plan_id}",
        json={
            "title": "Groceries",
            "category_id": "11111111-1111-1111-1111-111111111111",
            "items": [{"name": "Fruit"}],
        },
        headers=alice.headers,
    )
    assert invalid.status_code == 422
