"""Per-user glass appearance: defaults, saving, validation, isolation."""

from __future__ import annotations

import uuid

from tricount_but_better.models import User

LOOK = {
    "glass": True,
    "palette": "custom-dusk",
    "palettes": [
        {"id": "custom-dusk", "name": "  Dusk  ", "base": "#3A5BD9", "accent": "#f59e0b"},
    ],
    "glow": 1.4,
    "blur": 24,
    "fill": 70,
    "backdrop_seed": 123456789,
    "flow": True,
    "flow_speed": 2.5,
    "flow_range": 1.5,
}


def test_a_new_account_starts_with_the_standard_look(client, alice) -> None:
    look = client.get("/api/auth/me", headers=alice.headers).json()["appearance"]
    assert look["glass"] is False
    assert look["palette"] == "mint"
    assert look["palettes"] == []
    assert look["backdrop_seed"] == 0
    assert look["flow"] is False


def test_a_saved_look_comes_back_with_the_account(client, alice) -> None:
    saved = client.put("/api/auth/me/appearance", json=LOOK, headers=alice.headers)
    assert saved.status_code == 200, saved.text

    look = client.get("/api/auth/me", headers=alice.headers).json()["appearance"]
    assert look["glass"] is True
    assert look["flow_speed"] == 2.5
    assert look["backdrop_seed"] == 123456789
    # Colours are normalised and names trimmed, so the client never sees two spellings.
    assert look["palettes"] == [
        {"id": "custom-dusk", "name": "Dusk", "base": "#3a5bd9", "accent": "#f59e0b"}
    ]


def test_each_account_keeps_its_own_look(client, alice, bob) -> None:
    client.put("/api/auth/me/appearance", json=LOOK, headers=alice.headers)
    assert client.get("/api/auth/me", headers=bob.headers).json()["appearance"]["glass"] is False


def test_saving_replaces_the_whole_look(client, alice) -> None:
    client.put("/api/auth/me/appearance", json=LOOK, headers=alice.headers)
    client.put("/api/auth/me/appearance", json={"glass": True}, headers=alice.headers)

    look = client.get("/api/auth/me", headers=alice.headers).json()["appearance"]
    assert look["glass"] is True
    assert look["palettes"] == []
    assert look["blur"] == 18


def test_malformed_looks_are_refused(client, alice) -> None:
    bad = [
        {"palettes": [{"id": "x", "name": "X", "base": "red", "accent": "#000000"}]},
        {"palettes": [{"id": "x", "name": "   ", "base": "#000000", "accent": "#000000"}]},
        {"palettes": [{"id": "Bad Id", "name": "X", "base": "#000000", "accent": "#000000"}]},
        {
            "palettes": [
                {"id": "same", "name": "A", "base": "#000000", "accent": "#000000"},
                {"id": "same", "name": "B", "base": "#ffffff", "accent": "#ffffff"},
            ]
        },
        {
            "palettes": [
                {"id": f"p{i}", "name": "P", "base": "#000000", "accent": "#000000"}
                for i in range(13)
            ]
        },
        {"blur": 41},
        {"fill": 10},
        {"glow": -0.1},
        {"flow_speed": 10},
        {"backdrop_seed": -1},
    ]
    for body in bad:
        response = client.put("/api/auth/me/appearance", json=body, headers=alice.headers)
        assert response.status_code == 422, body


def test_a_corrupt_stored_look_falls_back_to_the_defaults(client, alice, session) -> None:
    user = session.get(User, uuid.UUID(alice.id))
    user.appearance = {"glass": "very", "blur": 9000}
    session.commit()

    me = client.get("/api/auth/me", headers=alice.headers)
    assert me.status_code == 200
    assert me.json()["appearance"]["glass"] is False


def test_saving_a_look_needs_a_session(client) -> None:
    assert client.put("/api/auth/me/appearance", json={"glass": True}).status_code == 401
