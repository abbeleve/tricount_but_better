"""Personal purchases keep every derived resource private, including prices."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from tricount_but_better.models import Invite, Notification, Team, TeamMember
from tricount_but_better.routers import expenses, planned_expenses


def _ledger(client, team, actor):
    response = client.post(f"/api/teams/{team}/personal", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _body(actor, **extra):
    body = {
        "title": "Private purchase",
        "payer_id": actor.id,
        "spent_at": "2026-11-08",
        "total": 12345,
        "shares": [{"user_id": actor.id}],
        **extra,
    }
    if body.get("split_mode") == "items":
        body["shares"] = []
    return body


def _buy(client, ledger, actor, **extra):
    response = client.post(
        f"/api/teams/{ledger}/expenses", headers=actor.headers, json=_body(actor, **extra)
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_ledgers_are_per_person_and_team_and_hidden_from_team_list(
    client, team, alice, bob, session
):
    personal = _ledger(client, team, bob)
    assert personal["is_personal"] is True
    assert personal["parent_team_id"] == team
    assert personal["currency"] == "RUB"
    assert [member["user_id"] for member in personal["members"]] == [bob.id]
    assert _ledger(client, team, bob)["id"] == personal["id"]
    assert _ledger(client, personal["id"], bob)["id"] == personal["id"]
    assert _ledger(client, team, alice)["id"] != personal["id"]
    for actor in (alice, bob):
        listed = client.get("/api/teams", headers=actor.headers).json()
        assert [entry["id"] for entry in listed] == [team]
    assert session.scalar(select(func.count(Team.id))) == 3


@pytest.mark.parametrize("mode", ["total", "items"])
def test_personal_expenses_always_belong_to_the_owner_and_support_edits_and_refunds(
    client, team, alice, bob, mode
):
    personal = _ledger(client, team, bob)["id"]
    overrides = {"payer_id": alice.id, "shares": [{"user_id": alice.id}]}
    if mode == "items":
        overrides.update(
            split_mode="items",
            items=[{"name": "Private item", "total": 12345, "shares": [{"user_id": alice.id}]}],
        )
    expense = _buy(client, personal, bob, **overrides)
    assert expense["payer_id"] == bob.id
    assert [(s["user_id"], s["amount"]) for s in expense["shares"]] == [(bob.id, 12345)]
    for item in expense["items"]:
        assert [(s["user_id"], s["amount"]) for s in item["shares"]] == [(bob.id, 12345)]
    endpoint = f"/api/teams/{personal}/expenses/{expense['id']}"
    response = client.put(endpoint, headers=bob.headers, json=_body(alice, total=-100))
    assert response.status_code == 200, response.text
    assert response.json()["payer_id"] == bob.id
    assert response.json()["shares"][0]["amount"] == -100
    listed = client.get(f"/api/teams/{personal}/expenses?q=Private", headers=bob.headers).json()
    assert listed["total_count"] == 1
    assert client.delete(endpoint, headers=bob.headers).status_code == 204
    assert client.get(endpoint, headers=bob.headers).status_code == 404


def test_parent_owner_cannot_read_write_or_discover_personal_resources(
    client, team, alice, bob, session
):
    personal = _ledger(client, team, bob)["id"]
    expense = _buy(client, personal, bob)
    # Parent-team ownership grants no rights over another member's ledger.
    for suffix in (
        "",
        "/expenses",
        f"/expenses/{expense['id']}",
        "/plans",
        "/shops",
        "/products",
        "/categories",
        "/category-totals",
        "/balances",
        "/spending",
        "/spending/people",
        "/prices/changes",
        "/prices/savings",
    ):
        response = client.get(f"/api/teams/{personal}{suffix}", headers=alice.headers)
        assert response.status_code == 404, (suffix, response.text)
    endpoint = f"/api/teams/{personal}/expenses/{expense['id']}"
    assert client.put(endpoint, headers=alice.headers, json=_body(alice)).status_code == 404
    assert client.delete(endpoint, headers=alice.headers).status_code == 404
    assert (
        client.post(
            f"/api/teams/{personal}/expenses", headers=alice.headers, json=_body(alice)
        ).status_code
        == 404
    )
    assert (
        client.get(f"/api/teams/{team}/expenses/{expense['id']}", headers=alice.headers).status_code
        == 404
    )
    # Defence in depth: a stray membership must not bypass the owner check.
    session.add(TeamMember(team_id=uuid.UUID(personal), user_id=uuid.UUID(alice.id)))
    session.commit()
    assert client.get(endpoint, headers=alice.headers).status_code == 404


def test_personal_purchases_leave_other_members_views_and_notifications_unchanged(
    client, team, alice, bob, carol, session, monkeypatch
):
    personal = _ledger(client, team, bob)["id"]
    paths = [
        "expenses",
        "balances",
        "spending",
        "spending/people",
        "category-totals",
        "prices/savings",
    ]
    before = {
        path: client.get(f"/api/teams/{team}/{path}", headers=alice.headers).json()
        for path in paths
    }

    def unexpected_push(*args):
        pytest.fail("a personal purchase must not schedule any push delivery")

    monkeypatch.setattr(expenses, "deliver_push", unexpected_push)
    monkeypatch.setattr(planned_expenses, "deliver_push", unexpected_push)
    _buy(client, personal, bob)
    for path, value in before.items():
        assert client.get(f"/api/teams/{team}/{path}", headers=alice.headers).json() == value
    assert client.get(f"/api/teams/{personal}/spending", headers=bob.headers).json()["days"] == [
        {"date": "2026-11-08", "total": 12345, "expense_count": 1}
    ]
    # Plans keep the same private behaviour when completed through the other write path.
    plan = client.post(
        f"/api/teams/{personal}/plans",
        headers=bob.headers,
        json={"title": "Private plan", "items": [{"name": "Coffee"}]},
    )
    assert plan.status_code == 201, plan.text
    completed = client.post(
        f"/api/teams/{personal}/plans/{plan.json()['id']}/complete",
        headers=bob.headers,
        json=_body(bob),
    )
    assert completed.status_code == 201, completed.text
    assert client.get(f"/api/teams/{team}/spending", headers=bob.headers).json()["days"] == [
        {"date": "2026-11-08", "total": 24690, "expense_count": 2}
    ]
    for actor in (alice, bob, carol):
        assert client.get("/api/notifications", headers=actor.headers).json() == {
            "items": [],
            "unread_count": 0,
        }
    assert session.scalar(select(func.count(Notification.id))) == 0


def test_personal_categories_shops_products_and_receipt_price_links_stay_private(
    client, team, alice, bob
):
    personal = _ledger(client, team, bob)["id"]
    shop = client.post(
        f"/api/teams/{personal}/shops", headers=bob.headers, json={"name": "Private shop"}
    ).json()
    category = client.post(
        f"/api/teams/{personal}/categories", headers=bob.headers, json={"name": "Private category"}
    ).json()
    expense = _buy(
        client,
        personal,
        bob,
        shop_id=shop["id"],
        category_id=category["id"],
        split_mode="items",
        items=[{"name": "Private product", "total": 12345, "shares": [{"user_id": bob.id}]}],
    )
    product_id = expense["items"][0]["product_id"]
    assert product_id is not None
    product = client.get(f"/api/teams/{personal}/products/{product_id}", headers=bob.headers).json()
    assert product["name"] == "Private product"
    assert product["prices"][0]["regular_from"]["expense_id"] == expense["id"]
    for actor in (alice, bob):
        assert client.get(f"/api/teams/{team}/shops", headers=actor.headers).json() == []
        assert (
            client.get(f"/api/teams/{team}/products", headers=actor.headers).json()["items"] == []
        )
        assert "Private category" not in str(
            client.get(f"/api/teams/{team}/categories", headers=actor.headers).json()
        )
    # A shared purchase cannot be used to expose a private product or shop.
    response = client.post(
        f"/api/teams/{team}/expenses",
        headers=bob.headers,
        json=_body(bob, shop_id=shop["id"]),
    )
    assert response.status_code == 422


def test_personal_ledgers_cannot_be_invited_into_even_with_a_forged_invite(
    client, team, alice, bob, session
):
    personal = _ledger(client, team, bob)["id"]
    response = client.post(f"/api/teams/{personal}/invites", json={}, headers=bob.headers)
    assert response.status_code == 403
    session.add(
        Invite(
            team_id=uuid.UUID(personal),
            created_by_id=uuid.UUID(bob.id),
            code="forged-private-invite",
        )
    )
    session.commit()
    assert (
        client.get("/api/invites/forged-private-invite", headers=alice.headers).status_code == 404
    )
    assert (
        client.post("/api/invites/forged-private-invite/accept", headers=alice.headers).status_code
        == 404
    )
