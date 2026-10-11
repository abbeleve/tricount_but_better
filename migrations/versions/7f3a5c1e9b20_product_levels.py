"""Describe goods in levels; drop till codes from names and merge what they split.

Products gain their levels (kind, variety, brand, pack size, sold by weight),
filled in by the next receipt that links each one.

Names now compare without the marking tag and pack code a till prints in front
of a marked good ("[M+]0829 САЛФЕТКИ ...") or a leading article number. Under
the old keys every pack of such a good became a product of its own, so stored
keys are recomputed and goods that now share a key -- by name in a team, or by
how one shop printed them -- are merged into the one bought most: purchases,
receipt names and shop prices move across (where two prices for one shop meet,
the more recently confirmed one stays), and product names lose the codes too.
The merge cannot be undone; a downgrade only drops the level columns.

Revision ID: 7f3a5c1e9b20
Revises: e4b7c2d91f30
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "7f3a5c1e9b20"
down_revision: str | None = "e4b7c2d91f30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# A copy of ``catalog.name_key`` as of this revision, so later changes to the
# app's matching cannot change what this migration did.
_WORD = re.compile(r"[^\W_]+")
_MARK = re.compile(r"^\s*\[\s*[MМ]\s*[+\-]?\s*\]\s*(?:\d{3,}\s+)?", re.IGNORECASE)
_ARTICLE = re.compile(r"^\s*\d{5,}\s+")


def _strip_codes(text: str) -> str:
    return _ARTICLE.sub("", _MARK.sub("", text, count=1), count=1).strip()


def _name_key(text: str) -> str:
    folded = unicodedata.normalize("NFKC", _strip_codes(text)).casefold().replace("ё", "е")
    return " ".join(_WORD.findall(folded))[:200]


def upgrade() -> None:
    with op.batch_alter_table("products") as batch:
        batch.add_column(sa.Column("kind", sa.String(length=80), nullable=True))
        batch.add_column(sa.Column("kind_key", sa.String(length=80), nullable=True))
        batch.add_column(sa.Column("variety", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column("brand", sa.String(length=80), nullable=True))
        batch.add_column(sa.Column("size", sa.Numeric(precision=12, scale=3), nullable=True))
        batch.add_column(sa.Column("size_unit", sa.String(length=3), nullable=True))
        batch.add_column(sa.Column("by_weight", sa.Boolean(), server_default="0", nullable=False))
        batch.create_index("ix_product_team_kind", ["team_id", "kind_key"])

    _merge_split_goods(op.get_bind())


def _merge_split_goods(conn: sa.Connection) -> None:
    products = conn.execute(
        sa.text("SELECT id, team_id, name, key, created_at FROM products")
    ).all()
    if not products:
        return
    aliases = conn.execute(
        sa.text("SELECT id, product_id, shop_id, name, key FROM product_aliases")
    ).all()
    bought = dict(
        conn.execute(
            sa.text(
                "SELECT product_id, count(*) FROM expense_items"
                " WHERE product_id IS NOT NULL GROUP BY product_id"
            )
        ).all()
    )

    # New names and keys. A name that is nothing but a code keeps what it had.
    renamed: dict = {}
    for product in products:
        key = _name_key(product.name)
        name = _strip_codes(product.name)[:200] if key else product.name
        renamed[product.id] = (name, key or product.key)
    alias_keys = {alias.id: _name_key(alias.name) or alias.key for alias in aliases}

    # Goods that are one: the same new key in a team, or the same new printed
    # name at a shop. Joined transitively.
    parent = {product.id: product.id for product in products}

    def root(product_id):
        while parent[product_id] != product_id:
            parent[product_id] = parent[parent[product_id]]
            product_id = parent[product_id]
        return product_id

    def join(ids: list) -> None:
        for other in ids[1:]:
            parent[root(other)] = root(ids[0])

    by_key: dict = defaultdict(list)
    for product in products:
        by_key[(product.team_id, renamed[product.id][1])].append(product.id)
    by_printed: dict = defaultdict(list)
    for alias in aliases:
        by_printed[(alias.shop_id, alias_keys[alias.id])].append(alias)
    for ids in by_key.values():
        join(ids)
    for same in by_printed.values():
        join([alias.product_id for alias in same])

    groups: dict = defaultdict(list)
    for product in products:
        groups[root(product.id)].append(product)
    keeper: dict = {}
    for members in groups.values():
        # The one bought most survives; the oldest of those on a tie.
        survivor = min(members, key=lambda p: (-bought.get(p.id, 0), str(p.created_at)))
        for product in members:
            keeper[product.id] = survivor.id

    gone = [product.id for product in products if keeper[product.id] != product.id]
    for product_id in gone:
        conn.execute(
            sa.text("UPDATE expense_items SET product_id = :keep WHERE product_id = :gone"),
            {"keep": keeper[product_id], "gone": product_id},
        )

    # One price per shop and good: the more recently confirmed one.
    if gone:
        prices = conn.execute(
            sa.text("SELECT id, product_id, shop_id, regular_on, sale_on FROM shop_prices")
        ).all()
        per_pair: dict = defaultdict(list)
        for price in prices:
            per_pair[(keeper.get(price.product_id, price.product_id), price.shop_id)].append(price)
        for (keep, _), rows in per_pair.items():
            if len(rows) == 1 and rows[0].product_id == keep:
                continue

            def confirmed(price, keep=keep):
                newest = max((d for d in (price.regular_on, price.sale_on) if d), default=None)
                return (newest is not None, newest or "", price.product_id == keep)

            best = max(rows, key=confirmed)
            for price in rows:
                if price.id != best.id:
                    conn.execute(
                        sa.text("DELETE FROM shop_prices WHERE id = :id"), {"id": price.id}
                    )
            conn.execute(
                sa.text("UPDATE shop_prices SET product_id = :keep WHERE id = :id"),
                {"keep": keep, "id": best.id},
            )

    # One printed name per shop. Keys move through a placeholder first -- "~"
    # never occurs in a key -- so no half-done step trips over uniqueness.
    changed = []
    for same in by_printed.values():
        for alias in same[1:]:
            conn.execute(sa.text("DELETE FROM product_aliases WHERE id = :id"), {"id": alias.id})
        alias = same[0]
        product_id = keeper[alias.product_id]
        if alias_keys[alias.id] != alias.key or product_id != alias.product_id:
            changed.append((alias.id, alias_keys[alias.id], product_id))
    for alias_id, _, _ in changed:
        conn.execute(
            sa.text("UPDATE product_aliases SET key = :key WHERE id = :id"),
            {"key": f"~{alias_id}", "id": alias_id},
        )
    for alias_id, key, product_id in changed:
        conn.execute(
            sa.text("UPDATE product_aliases SET key = :key, product_id = :product WHERE id = :id"),
            {"key": key, "product": product_id, "id": alias_id},
        )

    for product_id in gone:
        conn.execute(sa.text("DELETE FROM products WHERE id = :id"), {"id": product_id})
    kept = [
        (product.id, *renamed[product.id])
        for product in products
        if keeper[product.id] == product.id and renamed[product.id] != (product.name, product.key)
    ]
    for product_id, _, _ in kept:
        conn.execute(
            sa.text("UPDATE products SET key = :key WHERE id = :id"),
            {"key": f"~{product_id}", "id": product_id},
        )
    for product_id, name, key in kept:
        conn.execute(
            sa.text("UPDATE products SET name = :name, key = :key WHERE id = :id"),
            {"name": name, "key": key, "id": product_id},
        )


def downgrade() -> None:
    with op.batch_alter_table("products") as batch:
        batch.drop_index("ix_product_team_kind")
        batch.drop_column("by_weight")
        batch.drop_column("size_unit")
        batch.drop_column("size")
        batch.drop_column("brand")
        batch.drop_column("variety")
        batch.drop_column("kind_key")
        batch.drop_column("kind")
