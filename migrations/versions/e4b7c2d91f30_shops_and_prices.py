"""Add shops, products and per-shop prices; link expenses and lines to them.

Revision ID: e4b7c2d91f30
Revises: 830723854752
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "e4b7c2d91f30"
down_revision: str | None = "830723854752"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "shops",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("team_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("key", sa.String(length=120), nullable=False),
        sa.Column("address", sa.String(length=240), nullable=False),
        sa.Column("aliases", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("team_id", "key", name="uq_shop_key"),
    )
    op.create_index("ix_shops_team_id", "shops", ["team_id"])

    op.create_table(
        "products",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("team_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("team_id", "key", name="uq_product_key"),
    )
    op.create_index("ix_products_team_id", "products", ["team_id"])

    op.create_table(
        "product_aliases",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("shop_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("shop_id", "key", name="uq_product_alias"),
    )
    op.create_index("ix_product_aliases_product_id", "product_aliases", ["product_id"])

    op.create_table(
        "shop_prices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("shop_id", sa.Uuid(), nullable=False),
        sa.Column("regular_price", sa.BigInteger(), nullable=True),
        sa.Column("regular_on", sa.Date(), nullable=True),
        sa.Column("sale_price", sa.BigInteger(), nullable=True),
        sa.Column("sale_on", sa.Date(), nullable=True),
        sa.Column("sale_until", sa.Date(), nullable=True),
        sa.Column("reviewed_on", sa.Date(), nullable=True),
        sa.Column("reviewed_price", sa.BigInteger(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shop_id"], ["shops.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("product_id", "shop_id", name="uq_shop_price"),
    )
    op.create_index("ix_shop_prices_product_id", "shop_prices", ["product_id"])
    op.create_index("ix_shop_prices_shop_id", "shop_prices", ["shop_id"])

    with op.batch_alter_table("expenses") as batch:
        batch.add_column(sa.Column("shop_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_expenses_shop_id_shops", "shops", ["shop_id"], ["id"], ondelete="SET NULL"
        )
        batch.create_index("ix_expenses_shop_id", ["shop_id"])

    with op.batch_alter_table("expense_items") as batch:
        batch.add_column(sa.Column("product_id", sa.Uuid(), nullable=True))
        batch.add_column(
            sa.Column("on_sale", sa.Boolean(), server_default="0", nullable=False)
        )
        batch.add_column(sa.Column("regular_unit_price", sa.BigInteger(), nullable=True))
        batch.create_foreign_key(
            "fk_expense_items_product_id_products",
            "products",
            ["product_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_expense_items_product_id", ["product_id"])


def downgrade() -> None:
    with op.batch_alter_table("expense_items") as batch:
        batch.drop_index("ix_expense_items_product_id")
        batch.drop_constraint("fk_expense_items_product_id_products", type_="foreignkey")
        batch.drop_column("regular_unit_price")
        batch.drop_column("on_sale")
        batch.drop_column("product_id")

    with op.batch_alter_table("expenses") as batch:
        batch.drop_index("ix_expenses_shop_id")
        batch.drop_constraint("fk_expenses_shop_id_shops", type_="foreignkey")
        batch.drop_column("shop_id")

    op.drop_table("shop_prices")
    op.drop_table("product_aliases")
    op.drop_table("products")
    op.drop_table("shops")
