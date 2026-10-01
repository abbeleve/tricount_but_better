"""Shared custom categories stay within their team."""

from __future__ import annotations

import pytest


def test_member_creates_category_shared_with_every_member(client, team, alice, bob, carol):
    created = client.post(
        f"/api/teams/{team}/categories",
        json={"name": "  Pet supplies  ", "emoji": "🐾"},
        headers=bob.headers,
    )
    assert created.status_code == 201, created.text
    category = created.json()
    assert category["name"] == "Pet supplies"
    assert category["emoji"] == "🐾"
    assert category["is_archived"] is False

    for member in (alice, bob, carol):
        categories = client.get(f"/api/teams/{team}/categories", headers=member.headers).json()
        assert category in categories


def test_category_names_are_unique_within_each_team(client, team, alice, bob):
    url = f"/api/teams/{team}/categories"
    assert client.post(url, json={"name": "Pantry"}, headers=bob.headers).status_code == 201
    duplicate = client.post(url, json={"name": "  Pantry  "}, headers=alice.headers)
    assert duplicate.status_code == 409
    assert "already exists" in duplicate.json()["detail"]

    other_team = client.post(
        "/api/teams", json={"name": "Another flat"}, headers=alice.headers
    ).json()["id"]
    assert (
        client.post(
            f"/api/teams/{other_team}/categories", json={"name": "Pantry"}, headers=alice.headers
        ).status_code
        == 201
    )
    # A conflict rolls the session back; later writes still work.
    assert client.post(url, json={"name": "Pets"}, headers=bob.headers).status_code == 201


def test_categories_require_membership_and_cannot_cross_teams(client, team, alice, bob):
    category = client.post(
        f"/api/teams/{team}/categories", json={"name": "Pets"}, headers=bob.headers
    ).json()
    other_team = client.post(
        "/api/teams", json={"name": "Private flat"}, headers=alice.headers
    ).json()["id"]
    url = f"/api/teams/{other_team}/categories"

    assert client.post(url, json={"name": "Pets"}).status_code == 401
    assert client.get(url, headers=bob.headers).status_code == 404
    assert client.post(url, json={"name": "Pets"}, headers=bob.headers).status_code == 404
    assert (
        client.patch(
            f"{url}/{category['id']}", json={"name": "Hijacked"}, headers=alice.headers
        ).status_code
        == 404
    )

    categories = client.get(url, headers=alice.headers).json()
    assert category["id"] not in {item["id"] for item in categories}


@pytest.mark.parametrize("name", ["", "   ", "\t\n", "x" * 61])
def test_invalid_category_names_are_rejected(client, team, bob, name):
    url = f"/api/teams/{team}/categories"
    assert client.post(url, json={"name": name}, headers=bob.headers).status_code == 422


@pytest.mark.parametrize("name", ["", "   ", "\t\n", "x" * 61])
def test_invalid_category_renames_are_rejected(client, team, bob, name):
    url = f"/api/teams/{team}/categories"
    category = client.post(url, json={"name": "Pets"}, headers=bob.headers).json()
    assert (
        client.patch(
            f"{url}/{category['id']}", json={"name": name}, headers=bob.headers
        ).status_code
        == 422
    )


def test_custom_category_is_usable_for_plans_and_expenses(client, team, alice, bob):
    category_id = client.post(
        f"/api/teams/{team}/categories", json={"name": "Pets"}, headers=bob.headers
    ).json()["id"]

    planned = client.post(
        f"/api/teams/{team}/plans",
        json={
            "title": "Cat food",
            "category_id": category_id,
            "items": [{"name": "Kibble"}],
        },
        headers=alice.headers,
    )
    assert planned.status_code == 201, planned.text
    assert planned.json()["category_id"] == category_id

    expense = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Cat food",
            "payer_id": alice.id,
            "spent_at": "2026-10-01",
            "category_id": category_id,
            "split_mode": "items",
            "items": [
                {
                    "name": "Kibble",
                    "total": 500_00,
                    "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
                }
            ],
        },
        headers=alice.headers,
    )
    assert expense.status_code == 201, expense.text
    assert expense.json()["category_id"] == category_id
    totals = client.get(f"/api/teams/{team}/category-totals", headers=bob.headers).json()
    assert next(item for item in totals if item["category_id"] == category_id)["total"] == 500_00
