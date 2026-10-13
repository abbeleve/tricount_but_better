"""Link each saved price to the expense whose receipt brought it in.

Shop prices gain ``regular_expense_id`` and ``sale_expense_id``. Prices saved
before this had no link, so it is worked out from the purchases: a regular
price links to the first receipt of its latest unbroken run at that price at
that shop, up to the day it was last confirmed (a discounted line counts by the
regular price it printed); a sale price links to a receipt of that shop on the
day the sale was seen, at that price. A price no receipt shows -- typed in, or
read off a screenshot -- stays unlinked.

Revision ID: 7329f5bb3220
Revises: 7f3a5c1e9b20
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal

from alembic import op
import sqlalchemy as sa


revision: str = "7329f5bb3220"
down_revision: str | None = "7f3a5c1e9b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("shop_prices") as batch:
        batch.add_column(sa.Column("regular_expense_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("sale_expense_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_shop_prices_regular_expense_id_expenses",
            "expenses",
            ["regular_expense_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_foreign_key(
            "fk_shop_prices_sale_expense_id_expenses",
            "expenses",
            ["sale_expense_id"],
            ["id"],
            ondelete="SET NULL",
        )

    _link_saved_prices(op.get_bind())


def _paid_per_unit(total: int, quantity) -> int:
    """A copy of ``catalog.paid_per_unit`` as of this revision."""
    quantity = Decimal(str(quantity))
    if quantity <= 0:
        return total
    return int((Decimal(total) / quantity).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _link_saved_prices(conn: sa.Connection) -> None:
    prices = conn.execute(
        sa.text(
            "SELECT id, product_id, shop_id, regular_price, regular_on, sale_price, sale_on"
            " FROM shop_prices"
        )
    ).all()
    if not prices:
        return
    lines = defaultdict(list)
    for line in conn.execute(
        sa.text(
            "SELECT i.expense_id, i.product_id, e.shop_id, e.spent_at, i.total, i.quantity,"
            " i.on_sale, i.regular_unit_price"
            " FROM expense_items i JOIN expenses e ON e.id = i.expense_id"
            " WHERE i.product_id IS NOT NULL AND e.shop_id IS NOT NULL AND i.total > 0"
            " ORDER BY e.spent_at, e.created_at, i.position"
        )
    ):
        lines[(line.product_id, line.shop_id)].append(line)

    for price in prices:
        bought = lines.get((price.product_id, price.shop_id), [])
        regular = None
        if price.regular_price is not None and price.regular_on is not None:
            for line in bought:
                if line.spent_at > price.regular_on:
                    break
                if not line.on_sale:
                    seen = _paid_per_unit(line.total, line.quantity)
                elif line.regular_unit_price is not None:
                    seen = line.regular_unit_price
                else:
                    continue
                if seen != price.regular_price:
                    regular = None
                elif regular is None:
                    regular = line.expense_id
        sale = None
        if price.sale_price is not None and price.sale_on is not None:
            sale = next(
                (
                    line.expense_id
                    for line in bought
                    if line.spent_at == price.sale_on
                    and _paid_per_unit(line.total, line.quantity) == price.sale_price
                ),
                None,
            )
        if regular is not None or sale is not None:
            conn.execute(
                sa.text(
                    "UPDATE shop_prices SET regular_expense_id = :regular,"
                    " sale_expense_id = :sale WHERE id = :id"
                ),
                {"regular": regular, "sale": sale, "id": price.id},
            )


def downgrade() -> None:
    with op.batch_alter_table("shop_prices") as batch:
        batch.drop_constraint("fk_shop_prices_sale_expense_id_expenses", type_="foreignkey")
        batch.drop_constraint("fk_shop_prices_regular_expense_id_expenses", type_="foreignkey")
        batch.drop_column("sale_expense_id")
        batch.drop_column("regular_expense_id")
