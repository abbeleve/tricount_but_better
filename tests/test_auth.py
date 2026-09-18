"""Registration, login and token handling."""

from __future__ import annotations


def test_register_then_use_token(client, alice) -> None:
    me = client.get("/api/auth/me", headers=alice.headers)
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"


def test_email_is_unique(client, alice) -> None:
    again = client.post(
        "/api/auth/register",
        json={
            "email": "ALICE@example.com",
            "display_name": "Impostor",
            "password": "correct-horse-battery",
        },
    )
    assert again.status_code == 409


def test_login_rejects_a_wrong_password(client, alice) -> None:
    bad = client.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": "wrong-wrong-wrong"}
    )
    assert bad.status_code == 401


def test_login_does_not_reveal_whether_an_account_exists(client) -> None:
    missing = client.post(
        "/api/auth/login", json={"email": "nobody@example.com", "password": "whatever-123"}
    )
    assert missing.status_code == 401
    assert "incorrect" in missing.json()["detail"]


def test_short_passwords_are_refused(client) -> None:
    weak = client.post(
        "/api/auth/register",
        json={"email": "weak@example.com", "display_name": "Weak", "password": "short"},
    )
    assert weak.status_code == 422


def test_refresh_issues_a_new_pair(client, alice) -> None:
    refreshed = client.post(
        "/api/auth/refresh", json={"refresh_token": alice.tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200
    assert refreshed.json()["access_token"]


def test_an_access_token_is_not_a_refresh_token(client, alice) -> None:
    wrong_kind = client.post(
        "/api/auth/refresh", json={"refresh_token": alice.tokens["access_token"]}
    )
    assert wrong_kind.status_code == 401


def test_anonymous_requests_are_rejected(client) -> None:
    assert client.get("/api/teams").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401
