"""Engine and session wiring.

Default backend is SQLite: this is a tool for one household, and a single file
is far easier to run and back up than a database server. The models and queries
stay dialect-agnostic, so pointing ``DATABASE_URL`` at Postgres later needs no
code change -- only ``uv sync --extra postgres``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import get_settings

_settings = get_settings()
_url = _settings.database_url
_is_sqlite = _url.startswith("sqlite")

_engine_kwargs: dict[str, Any] = {"pool_pre_ping": True, "future": True}

if _is_sqlite:
    # Requests are served from a worker thread, so the default same-thread
    # guard has to come off; concurrency is handled by WAL plus a busy timeout.
    _engine_kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    if ":memory:" in _url or _url == "sqlite://":
        # An in-memory database lives inside one connection, so every session
        # must share it. Without StaticPool each checkout sees an empty schema.
        _engine_kwargs["poolclass"] = StaticPool
    else:
        # Create the parent directory so a fresh checkout can just start.
        file_path = _url.split("///", 1)[-1]
        if file_path:
            Path(file_path).parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(_url, **_engine_kwargs)


if _is_sqlite:

    @event.listens_for(Engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record) -> None:  # noqa: ANN001
        """Make SQLite behave like a real database.

        ``foreign_keys`` is OFF by default in SQLite, which would silently skip
        every ``ON DELETE CASCADE`` in the schema -- deleting a team would leave
        orphaned expenses behind. WAL lets reads continue during a write.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
