"""Store each user's glass appearance settings.

Revision ID: c3e8b1f2a9d4
Revises: a21f6c807e35
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "c3e8b1f2a9d4"
down_revision: str | None = "a21f6c807e35"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("appearance", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("users") as batch:
        batch.drop_column("appearance")
