"""Teams, invites, membership and access control."""

from __future__ import annotations


def test_creator_owns_the_team_and_gets_default_categories(client, alice) -> None:
    created = client.post(
        "/api/teams", json={"name": "Flat 42", "currency": "RUB"}, headers=alice.headers
    )
    assert created.status_code == 201
    body = created.json()
    assert body["my_role"] == "owner"
    assert len(body["members"]) == 1

    categories = client.get(f"/api/teams/{body['id']}/categories", headers=alice.headers).json()
    assert len(categories) >= 5


def test_invite_flow_adds_members(client, team, alice, bob, carol) -> None:
    detail = client.get(f"/api/teams/{team}", headers=alice.headers).json()
    assert {m["display_name"] for m in detail["members"]} == {"Alice", "Bob", "Carol"}
    assert detail["my_role"] == "owner"

    bobs_view = client.get(f"/api/teams/{team}", headers=bob.headers).json()
    assert bobs_view["my_role"] == "member"


def test_invite_preview_shows_the_team_before_joining(client, alice, bob) -> None:
    team_id = client.post("/api/teams", json={"name": "Ski trip"}, headers=alice.headers).json()[
        "id"
    ]
    invite = client.post(f"/api/teams/{team_id}/invites", json={}, headers=alice.headers).json()

    preview = client.get(f"/api/invites/{invite['code']}", headers=bob.headers)
    assert preview.status_code == 200
    assert preview.json()["team_name"] == "Ski trip"


def test_revoked_invites_stop_working(client, alice, bob) -> None:
    team_id = client.post("/api/teams", json={"name": "Ski trip"}, headers=alice.headers).json()[
        "id"
    ]
    invite = client.post(f"/api/teams/{team_id}/invites", json={}, headers=alice.headers).json()
    client.delete(f"/api/teams/{team_id}/invites/{invite['id']}", headers=alice.headers)

    refused = client.post(f"/api/invites/{invite['code']}/accept", headers=bob.headers)
    assert refused.status_code == 404


def test_a_stranger_cannot_see_the_team_exists(client, team, alice) -> None:
    stranger = client.post(
        "/api/auth/register",
        json={
            "email": "mallory@example.com",
            "display_name": "Mallory",
            "password": "correct-horse-battery",
        },
    ).json()
    headers = {"Authorization": f"Bearer {stranger['access_token']}"}
    # 404, not 403: team ids must not be probeable.
    assert client.get(f"/api/teams/{team}", headers=headers).status_code == 404
    assert client.get(f"/api/teams/{team}/expenses", headers=headers).status_code == 404


def test_only_owners_can_rename_or_invite(client, team, bob) -> None:
    assert (
        client.patch(
            f"/api/teams/{team}", json={"name": "Hijacked"}, headers=bob.headers
        ).status_code
        == 403
    )
    assert (
        client.post(f"/api/teams/{team}/invites", json={}, headers=bob.headers).status_code == 403
    )


def test_team_list_reports_my_own_balance(client, team, alice, bob, carol) -> None:
    client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Groceries",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "total": 300_00,
            "shares": [{"user_id": a.id} for a in (alice, bob, carol)],
        },
        headers=alice.headers,
    )
    mine = client.get("/api/teams", headers=alice.headers).json()
    assert mine[0]["my_balance"] == 200_00
    assert mine[0]["member_count"] == 3

    theirs = client.get("/api/teams", headers=bob.headers).json()
    assert theirs[0]["my_balance"] == -100_00


def test_cannot_remove_someone_who_still_owes_money(client, team, alice, bob, carol) -> None:
    client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Groceries",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "total": 300_00,
            "shares": [{"user_id": a.id} for a in (alice, bob, carol)],
        },
        headers=alice.headers,
    )
    blocked = client.delete(f"/api/teams/{team}/members/{bob.id}", headers=alice.headers)
    assert blocked.status_code == 409
    assert "settle up" in blocked.json()["detail"]


def test_settlement_clears_a_balance(client, team, alice, bob, carol) -> None:
    client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Groceries",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "total": 300_00,
            "shares": [{"user_id": a.id} for a in (alice, bob, carol)],
        },
        headers=alice.headers,
    )
    paid = client.post(
        f"/api/teams/{team}/settlements",
        json={
            "from_user_id": bob.id,
            "to_user_id": alice.id,
            "amount": 100_00,
            "settled_at": "2026-09-05",
        },
        headers=bob.headers,
    )
    assert paid.status_code == 201

    balances = client.get(f"/api/teams/{team}/balances", headers=alice.headers).json()
    by_user = {b["user_id"]: b["net"] for b in balances["balances"]}
    assert by_user[bob.id] == 0
    assert by_user[alice.id] == 100_00
    assert sum(by_user.values()) == 0


def test_a_team_must_keep_an_owner(client, team, alice) -> None:
    demoted = client.patch(
        f"/api/teams/{team}/members/{alice.id}", json={"role": "member"}, headers=alice.headers
    )
    assert demoted.status_code == 409
