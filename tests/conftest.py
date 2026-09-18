"""Test harness: a throwaway SQLite database per test."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="tricount-test-"))
# Must be set before the application package is imported: db.py builds its
# engine from settings at import time.
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("JWT_SECRET", "test-secret-not-used-anywhere-real")
os.environ.setdefault("UPLOAD_DIR", str(_TMP / "uploads"))
os.environ.setdefault("VLM_PROVIDER", "disabled")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from tricount_but_better.db import SessionLocal, engine  # noqa: E402
from tricount_but_better.main import create_app  # noqa: E402
from tricount_but_better.models import Base  # noqa: E402


@pytest.fixture
def client():
    Base.metadata.create_all(engine)
    with TestClient(create_app()) as test_client:
        yield test_client
    Base.metadata.drop_all(engine)


@pytest.fixture
def session():
    with SessionLocal() as db:
        yield db


class Actor:
    """A registered user plus the header block that authenticates them."""

    def __init__(self, client: TestClient, email: str, name: str):
        response = client.post(
            "/api/auth/register",
            json={"email": email, "display_name": name, "password": "correct-horse-battery"},
        )
        assert response.status_code == 201, response.text
        self.tokens = response.json()
        self.headers = {"Authorization": f"Bearer {self.tokens['access_token']}"}
        self.name = name
        self.id = client.get("/api/auth/me", headers=self.headers).json()["id"]


@pytest.fixture
def alice(client) -> Actor:
    return Actor(client, "alice@example.com", "Alice")


@pytest.fixture
def bob(client) -> Actor:
    return Actor(client, "bob@example.com", "Bob")


@pytest.fixture
def carol(client) -> Actor:
    return Actor(client, "carol@example.com", "Carol")


@pytest.fixture
def team(client, alice, bob, carol):
    """A three-person flat share -- the scenario the whole app exists for."""
    created = client.post(
        "/api/teams", json={"name": "Flat 42", "currency": "RUB"}, headers=alice.headers
    )
    assert created.status_code == 201, created.text
    team_id = created.json()["id"]

    invite = client.post(f"/api/teams/{team_id}/invites", json={}, headers=alice.headers).json()
    for actor in (bob, carol):
        joined = client.post(f"/api/invites/{invite['code']}/accept", headers=actor.headers)
        assert joined.status_code == 200, joined.text
    return team_id
