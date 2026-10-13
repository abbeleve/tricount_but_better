"""Data migrations, run with Alembic against a file on disk.

Only the tables a migration reads are filled; SQLite does not enforce foreign
keys on these connections, so the rows need no teams, users or expenses.
"""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _alembic(database: Path, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{database}"}
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(ROOT / "src"), env.get("PYTHONPATH")]))
    subprocess.run(
        [sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, check=True, capture_output=True
    )


def _id() -> str:
    return uuid.uuid4().hex  # how SQLAlchemy's Uuid type stores ids in SQLite


def _old_key(text: str) -> str:
    """The key as it was before this migration: codes and all."""
    return " ".join(re.findall(r"[^\W_]+", text.casefold()))


NAPKINS = "САЛФЕТКИ ЛЕНТА ВЛАЖНЫЕ Д/УХОДА ЗА ЛЕЖА"
NAPKINS_KEY = "салфетки лента влажные д ухода за лежа"


def test_packs_split_by_their_marking_codes_become_one_good(tmp_path) -> None:
    database = tmp_path / "app.db"
    _alembic(database, "upgrade", "e4b7c2d91f30")
    team, lenta, other_shop = _id(), _id(), _id()
    # Three packs of one good, each printed with its own code, each made a
    # product; a fourth reading got a readable name of its own.
    packs = {code: _id() for code in ("0829", "2196", "5143")}
    readable, bananas, milk = _id(), _id(), _id()
    products = [
        (packs["0829"], f"[M+]0829 {NAPKINS}", "2026-10-01"),
        (packs["2196"], f"[M+]2196 {NAPKINS}", "2026-10-02"),
        (packs["5143"], f"[M+]5143 {NAPKINS}", "2026-10-03"),
        (readable, "Салфетки влажные Лента", "2026-10-04"),
        (bananas, "Бананы", "2026-10-01"),
        (milk, "3502234 МОЛОКО ПРОСТОКВАШИНО 2,5% 930МЛ", "2026-10-01"),
    ]
    aliases = [
        (packs["0829"], lenta, f"[M+]0829 {NAPKINS}"),
        (packs["2196"], lenta, f"[M+]2196 {NAPKINS}"),
        (packs["5143"], lenta, f"[M+]5143 {NAPKINS}"),
        (readable, lenta, f"[M+]7731 {NAPKINS}"),
        (bananas, lenta, "КГ БАНАНЫ КГ"),
        (packs["0829"], other_shop, f"[M+]0829 {NAPKINS}"),
    ]
    prices = [  # (product, shop, regular price, confirmed on)
        (packs["0829"], lenta, 204_99, "2026-10-01"),
        (packs["2196"], lenta, 199_99, "2026-10-08"),
        (readable, lenta, 209_99, "2026-09-01"),
        (packs["0829"], other_shop, 210_00, "2026-10-02"),
    ]
    bought = [packs["0829"], packs["2196"], packs["2196"], readable, bananas]

    with sqlite3.connect(database) as db:
        db.executemany(
            "INSERT INTO products (id, team_id, name, key, created_at) VALUES (?, ?, ?, ?, ?)",
            [(pid, team, name, _old_key(name), created) for pid, name, created in products],
        )
        db.executemany(
            "INSERT INTO product_aliases (id, product_id, shop_id, name, key)"
            " VALUES (?, ?, ?, ?, ?)",
            [(_id(), pid, shop, name, _old_key(name)) for pid, shop, name in aliases],
        )
        db.executemany(
            "INSERT INTO shop_prices"
            " (id, product_id, shop_id, regular_price, regular_on, updated_at)"
            " VALUES (?, ?, ?, ?, ?, '2026-10-10')",
            [(_id(), *price) for price in prices],
        )
        db.executemany(
            "INSERT INTO expense_items (id, expense_id, position, name, quantity, unit_price,"
            " total, product_id, on_sale) VALUES (?, ?, 0, 'line', 1, 100, 100, ?, 0)",
            [(_id(), _id(), product) for product in bought],
        )

    _alembic(database, "upgrade", "head")

    with sqlite3.connect(database) as db:
        rows = db.execute("SELECT id, name, key FROM products ORDER BY name").fetchall()
        assert {pid for pid, _, _ in rows} == {packs["2196"], bananas, milk}  # bought most
        assert dict((pid, (name, key)) for pid, name, key in rows) == {
            packs["2196"]: (NAPKINS, NAPKINS_KEY),
            bananas: ("Бананы", "бананы"),
            milk: ("МОЛОКО ПРОСТОКВАШИНО 2,5% 930МЛ", "молоко простоквашино 2 5 930мл"),
        }
        assert db.execute(
            "SELECT product_id, count(*) FROM expense_items GROUP BY product_id ORDER BY 2"
        ).fetchall() == [(bananas, 1), (packs["2196"], 4)]
        assert sorted(
            db.execute("SELECT shop_id, product_id, key FROM product_aliases").fetchall()
        ) == sorted(
            [
                (lenta, packs["2196"], NAPKINS_KEY),
                (lenta, bananas, "кг бананы кг"),
                (other_shop, packs["2196"], NAPKINS_KEY),
            ]
        )
        # The newest confirmed price per shop survives the merge.
        assert sorted(
            db.execute("SELECT shop_id, product_id, regular_price FROM shop_prices").fetchall()
        ) == sorted([(lenta, packs["2196"], 199_99), (other_shop, packs["2196"], 210_00)])


def test_saved_prices_link_to_the_receipt_that_brought_them_in(tmp_path) -> None:
    database = tmp_path / "app.db"
    _alembic(database, "upgrade", "7f3a5c1e9b20")
    team, lenta, metro = _id(), _id(), _id()
    milk, coffee, rice = _id(), _id(), _id()
    first, again, rise, back = _id(), _id(), _id(), _id()  # milk: 89.90, 89.90, 99.90, 89.90
    full, sale = _id(), _id()  # coffee: 499.00, then 349.00 on sale printing 499.00
    expenses = [  # (id, shop, spent on)
        (first, lenta, "2026-09-01"),
        (again, lenta, "2026-09-08"),
        (rise, lenta, "2026-09-15"),
        (back, lenta, "2026-09-22"),
        (full, metro, "2026-10-01"),
        (sale, metro, "2026-10-05"),
    ]
    lines = [  # (expense, product, total, quantity, on sale, printed regular)
        (first, milk, 89_90, 1, 0, None),
        (again, milk, 179_80, 2, 0, None),
        (rise, milk, 99_90, 1, 0, None),
        (back, milk, 89_90, 1, 0, None),
        (full, coffee, 499_00, 1, 0, None),
        (sale, coffee, 349_00, 1, 1, 499_00),
    ]
    prices = [  # (product, shop, regular, regular on, sale, sale on)
        # Back at 89.90 after a rise: the receipt that brought it back.
        (milk, lenta, 89_90, "2026-09-22", None, None),
        (coffee, metro, 499_00, "2026-10-05", 349_00, "2026-10-05"),
        (rice, lenta, 120_00, "2026-10-01", None, None),  # typed in: no receipt shows it
    ]

    with sqlite3.connect(database) as db:
        db.executemany(
            "INSERT INTO expenses (id, team_id, payer_id, created_by_id, shop_id, title, note,"
            " currency, total, spent_at, split_mode, source, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, 'Shop', '', 'RUB', 0, ?, 'items', 'manual', ?, ?)",
            [(eid, team, _id(), _id(), shop, on, on, on) for eid, shop, on in expenses],
        )
        db.executemany(
            "INSERT INTO expense_items (id, expense_id, position, name, quantity, unit_price,"
            " total, product_id, on_sale, regular_unit_price)"
            " VALUES (?, ?, 0, 'line', ?, 0, ?, ?, ?, ?)",
            [(_id(), e, q, total, p, s, r) for e, p, total, q, s, r in lines],
        )
        db.executemany(
            "INSERT INTO shop_prices (id, product_id, shop_id, regular_price, regular_on,"
            " sale_price, sale_on, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-10')",
            [(_id(), *price) for price in prices],
        )

    _alembic(database, "upgrade", "head")

    with sqlite3.connect(database) as db:
        links = {
            product: (regular, sale)
            for product, regular, sale in db.execute(
                "SELECT product_id, regular_expense_id, sale_expense_id FROM shop_prices"
            )
        }
    assert links == {milk: (back, None), coffee: (full, sale), rice: (None, None)}

    _alembic(database, "downgrade", "7f3a5c1e9b20")
    with sqlite3.connect(database) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(shop_prices)")}
    assert "regular_expense_id" not in columns
