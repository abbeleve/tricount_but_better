"""Isolated, single-owner ledgers for personal expenses.

Revision ID: b6f14a209d73
Revises: 7329f5bb3220
"""

from alembic import op
import sqlalchemy as sa

revision = "b6f14a209d73"
down_revision = "7329f5bb3220"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("teams") as batch:
        batch.add_column(sa.Column("parent_team_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("personal_owner_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_personal_ledger_parent", "teams", ["parent_team_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_foreign_key(
            "fk_personal_ledger_owner", "users", ["personal_owner_id"], ["id"], ondelete="CASCADE"
        )
        batch.create_unique_constraint("uq_personal_ledger", ["parent_team_id", "personal_owner_id"])
        batch.create_check_constraint(
            "ck_personal_ledger_owner", "(parent_team_id IS NULL) = (personal_owner_id IS NULL)"
        )


def downgrade() -> None:
    # Private records must never become shared when rolling the schema back.
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT count(*) FROM teams WHERE personal_owner_id IS NOT NULL")):
        raise RuntimeError("Remove personal ledgers before downgrading this migration")
    with op.batch_alter_table("teams") as batch:
        batch.drop_constraint("ck_personal_ledger_owner", type_="check")
        batch.drop_constraint("uq_personal_ledger", type_="unique")
        batch.drop_constraint("fk_personal_ledger_owner", type_="foreignkey")
        batch.drop_constraint("fk_personal_ledger_parent", type_="foreignkey")
        batch.drop_column("personal_owner_id")
        batch.drop_column("parent_team_id")
