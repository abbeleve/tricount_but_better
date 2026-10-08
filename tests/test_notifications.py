"""Adding an expense tells everyone else in the team, in the app and by push."""

from __future__ import annotations

import os

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from tricount_but_better import notifications as notifications_module
from tricount_but_better.models import PushSubscription
from tricount_but_better.notifications import format_money
from tricount_but_better.webpush import PushOutcome, _point, b64url_encode

FCM = "https://fcm.googleapis.com/fcm/send/"


def _add(client, team, actor, *, total=300_00, people=(), title="Groceries"):
    body = {
        "title": title,
        "payer_id": actor.id,
        "spent_at": "2026-09-01",
        "total": total,
        "shares": [{"user_id": p.id} for p in (people or (actor,))],
    }
    response = client.post(f"/api/teams/{team}/expenses", json=body, headers=actor.headers)
    assert response.status_code == 201, response.text
    return response.json()


def _inbox(client, actor):
    response = client.get("/api/notifications", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _subscription(name: str, language: str = "en") -> dict:
    key = ec.generate_private_key(ec.SECP256R1())
    return {
        "endpoint": FCM + name,
        "keys": {
            "p256dh": b64url_encode(_point(key.public_key())),
            "auth": b64url_encode(os.urandom(16)),
        },
        "language": language,
    }


class FakeSender:
    def __init__(self, outcome: PushOutcome = PushOutcome.sent):
        self.outcome = outcome
        self.sent: list[tuple[str, dict]] = []

    def send(self, target, message):
        self.sent.append((target.endpoint, message))
        return self.outcome


@pytest.fixture
def sender(monkeypatch) -> FakeSender:
    fake = FakeSender()
    monkeypatch.setattr(notifications_module, "get_push_sender", lambda settings: fake)
    return fake


# ------------------------------------------------------------------------ in-app


def test_a_new_expense_notifies_everyone_but_whoever_added_it(
    client, team, alice, bob, carol
) -> None:
    expense = _add(client, team, alice, total=300_00, people=(alice, bob))

    assert _inbox(client, alice) == {"items": [], "unread_count": 0}

    bob_inbox = _inbox(client, bob)
    assert bob_inbox["unread_count"] == 1
    [note] = bob_inbox["items"]
    assert note["kind"] == "expense_created"
    assert note["read"] is False
    assert note["team_id"] == team and note["team_name"] == "Flat 42"
    assert note["actor_id"] == alice.id and note["actor_name"] == "Alice"
    assert note["expense_id"] == expense["id"]
    assert (note["title"], note["total"], note["currency"]) == ("Groceries", 300_00, "RUB")
    assert note["share"] == 150_00
    assert note["created_at"].endswith("Z")  # explicit UTC, never a naive local time

    # Carol was not in on it, but still hears about money moving in her team.
    [carols] = _inbox(client, carol)["items"]
    assert carols["share"] == 0


def test_newest_first_and_only_your_own(client, team, alice, bob, carol) -> None:
    _add(client, team, alice, title="First")
    _add(client, team, bob, title="Second")

    titles = [n["title"] for n in _inbox(client, carol)["items"]]
    assert titles == ["Second", "First"]
    assert [n["title"] for n in _inbox(client, alice)["items"]] == ["Second"]
    assert [n["title"] for n in _inbox(client, bob)["items"]] == ["First"]


def test_marking_read_by_id_and_all_at_once(client, team, alice, bob, carol) -> None:
    for title in ("One", "Two", "Three"):
        _add(client, team, alice, title=title)
    items = _inbox(client, bob)["items"]

    marked = client.post(
        "/api/notifications/read", json={"ids": [items[0]["id"]]}, headers=bob.headers
    )
    assert marked.status_code == 200, marked.text
    assert marked.json() == {"unread_count": 2}
    assert [n["read"] for n in _inbox(client, bob)["items"]] == [True, False, False]

    everything = client.post("/api/notifications/read", json={}, headers=bob.headers)
    assert everything.json() == {"unread_count": 0}
    # Carol's copies are untouched by Bob reading his.
    assert _inbox(client, carol)["unread_count"] == 3


def test_someone_elses_ids_are_ignored(client, team, alice, bob, carol) -> None:
    _add(client, team, alice)
    carols_id = _inbox(client, carol)["items"][0]["id"]
    response = client.post(
        "/api/notifications/read", json={"ids": [carols_id]}, headers=bob.headers
    )
    assert response.json() == {"unread_count": 1}
    assert _inbox(client, carol)["unread_count"] == 1


def test_editing_an_expense_does_not_notify_again(client, team, alice, bob) -> None:
    expense = _add(client, team, alice)
    updated = client.put(
        f"/api/teams/{team}/expenses/{expense['id']}",
        json={
            "title": "Groceries and wine",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "total": 500_00,
            "shares": [{"user_id": alice.id}],
        },
        headers=alice.headers,
    )
    assert updated.status_code == 200, updated.text
    [note] = _inbox(client, bob)["items"]
    assert (note["title"], note["total"]) == ("Groceries", 300_00)  # as it was announced


def test_deleting_the_expense_removes_its_notifications(client, team, alice, bob) -> None:
    expense = _add(client, team, alice)
    deleted = client.delete(f"/api/teams/{team}/expenses/{expense['id']}", headers=alice.headers)
    assert deleted.status_code == 204
    assert _inbox(client, bob) == {"items": [], "unread_count": 0}


def test_completing_a_plan_notifies_like_any_new_expense(client, team, alice, bob) -> None:
    plan = client.post(
        f"/api/teams/{team}/plans",
        json={"title": "Party", "items": [{"name": "Cake"}]},
        headers=bob.headers,
    ).json()
    completed = client.post(
        f"/api/teams/{team}/plans/{plan['id']}/complete",
        json={
            "title": "Party",
            "payer_id": bob.id,
            "spent_at": "2026-09-02",
            "total": 90_00,
            "shares": [{"user_id": alice.id}, {"user_id": bob.id}],
        },
        headers=bob.headers,
    )
    assert completed.status_code == 201, completed.text
    [note] = _inbox(client, alice)["items"]
    assert (note["title"], note["actor_name"], note["share"]) == ("Party", "Bob", 45_00)
    assert _inbox(client, bob)["items"] == []


def test_a_failed_expense_notifies_nobody(client, team, alice, bob) -> None:
    response = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Bad",
            "payer_id": alice.id,
            "spent_at": "2026-09-01",
            "total": 100,
            "shares": [{"user_id": "00000000-0000-0000-0000-000000000000"}],
        },
        headers=alice.headers,
    )
    assert response.status_code == 422
    assert _inbox(client, bob)["unread_count"] == 0


def test_leaving_a_team_hides_its_news(client, team, alice, bob, carol) -> None:
    _add(client, team, alice)
    left = client.delete(f"/api/teams/{team}/members/{carol.id}", headers=carol.headers)
    assert left.status_code == 204, left.text
    assert _inbox(client, carol) == {"items": [], "unread_count": 0}


def test_notifications_need_a_session(client) -> None:
    assert client.get("/api/notifications").status_code == 401


# -------------------------------------------------------------------------- push


def test_config_publishes_the_push_key(client) -> None:
    key = client.get("/api/config").json()["push_public_key"]
    assert isinstance(key, str) and len(key) == 87  # 65 bytes, base64url


def test_push_goes_to_each_recipients_devices_in_their_language(
    client, team, alice, bob, carol, sender, session
) -> None:
    for actor, name, language in ((bob, "bob-phone", "ru"), (bob, "bob-laptop", "en")):
        saved = client.put(
            "/api/push/subscriptions", json=_subscription(name, language), headers=actor.headers
        )
        assert saved.status_code == 204, saved.text
    client.put("/api/push/subscriptions", json=_subscription("alice-phone"), headers=alice.headers)

    expense = _add(client, team, alice, total=1_250_50, people=(alice, bob))

    sent = dict(sender.sent)
    assert set(sent) == {FCM + "bob-phone", FCM + "bob-laptop"}  # never the author's own
    [note] = _inbox(client, bob)["items"]
    url = f"/teams/{team}/expenses/{expense['id']}?n={note['id']}"

    assert sent[FCM + "bob-laptop"] == {
        "id": note["id"],
        "title": "Flat 42",
        "body": "Alice added “Groceries” · RUB\u00a01,250.50 · your share RUB\u00a0625.25",
        "url": url,
        "unread": 1,
    }
    assert sent[FCM + "bob-phone"]["body"] == (
        "Alice: новый расход «Groceries» · 1 250,50 ₽ · ваша доля 625,25 ₽"
    )


def test_a_device_the_push_service_has_forgotten_is_dropped(
    client, team, alice, bob, sender, session
) -> None:
    client.put("/api/push/subscriptions", json=_subscription("bob-old"), headers=bob.headers)
    sender.outcome = PushOutcome.gone
    _add(client, team, alice)
    assert len(sender.sent) == 1
    assert session.scalars(select(PushSubscription)).all() == []
    # The in-app copy is unaffected.
    assert _inbox(client, bob)["unread_count"] == 1


def test_a_transient_failure_keeps_the_device(client, team, alice, bob, sender, session) -> None:
    client.put("/api/push/subscriptions", json=_subscription("bob-phone"), headers=bob.headers)
    sender.outcome = PushOutcome.failed
    _add(client, team, alice)
    assert len(session.scalars(select(PushSubscription)).all()) == 1


def test_a_crashing_sender_does_not_lose_the_expense(client, team, alice, bob, monkeypatch) -> None:
    class Broken:
        def send(self, target, message):
            raise RuntimeError("push service exploded")

    monkeypatch.setattr(notifications_module, "get_push_sender", lambda settings: Broken())
    client.put("/api/push/subscriptions", json=_subscription("bob-phone"), headers=bob.headers)
    _add(client, team, alice)
    assert _inbox(client, bob)["unread_count"] == 1


def test_a_shared_browser_follows_whoever_signed_in_last(
    client, team, alice, bob, carol, sender, session
) -> None:
    device = _subscription("shared-tablet")
    client.put("/api/push/subscriptions", json=device, headers=bob.headers)
    client.put("/api/push/subscriptions", json=device, headers=carol.headers)

    [row] = session.scalars(select(PushSubscription)).all()
    assert str(row.user_id) == carol.id

    _add(client, team, bob)
    assert [endpoint for endpoint, _ in sender.sent] == [FCM + "shared-tablet"]


def test_turning_push_off_only_removes_your_own_device(
    client, team, alice, bob, carol, sender, session
) -> None:
    device = _subscription("bob-phone")
    client.put("/api/push/subscriptions", json=device, headers=bob.headers)

    # Someone else knowing the endpoint is not enough to switch it off.
    client.request(
        "DELETE",
        "/api/push/subscriptions",
        json={"endpoint": device["endpoint"]},
        headers=carol.headers,
    )
    assert len(session.scalars(select(PushSubscription)).all()) == 1

    removed = client.request(
        "DELETE",
        "/api/push/subscriptions",
        json={"endpoint": device["endpoint"]},
        headers=bob.headers,
    )
    assert removed.status_code == 204
    _add(client, team, alice)
    assert sender.sent == []


def test_subscriptions_must_point_at_a_real_push_service(client, alice) -> None:
    device = _subscription("x")
    device["endpoint"] = "https://127.0.0.1:8010/api/health"
    response = client.put("/api/push/subscriptions", json=device, headers=alice.headers)
    assert response.status_code == 422
    assert "push service" in response.json()["detail"]

    device = _subscription("y")
    device["keys"]["auth"] = "c2hvcnQ"
    assert (
        client.put("/api/push/subscriptions", json=device, headers=alice.headers).status_code == 422
    )


# --------------------------------------------------------------------- formatting


@pytest.mark.parametrize(
    ("minor", "currency", "language", "expected"),
    [
        (1_250_50, "RUB", "ru", "1 250,50 ₽"),
        (1_250_50, "RUB", "en", "RUB\u00a01,250.50"),
        (1_250_50, "KZT", "ru", "1\u00a0250,50\u00a0KZT"),
        (1_250_50, "GBP", "ru", "1\u00a0250,50\u00a0£"),
        (99, "USD", "en", "$0.99"),
        (-5_00, "EUR", "en", "-€5.00"),
        (1_234_567, "JPY", "en", "¥1,234,567"),
        (1_000_00, "RSD", "en", "RSD 1,000.00"),
        (1_000_00, "RSD", "ru", "1 000,00 RSD"),
    ],
)
def test_money_reads_like_the_app_shows_it(minor, currency, language, expected) -> None:
    assert format_money(minor, currency, language) == expected
