"""Shops, goods, and what they cost: tracking, review of new prices, and sales."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from tricount_but_better.catalog import name_key, paid_per_unit, shop_key
from tricount_but_better.models import Expense

TODAY = date.today()


def _shop(client, team, actor, name, **extra):
    response = client.post(
        f"/api/teams/{team}/shops", json={"name": name, **extra}, headers=actor.headers
    )
    assert response.status_code == 201, response.text
    return response.json()


def _buy(client, team, actor, shop_id, lines, spent_at=TODAY, expense_id=None):
    """Save an itemised expense; each line is (name, total) or a dict of extras."""
    items = []
    for line in lines:
        if isinstance(line, tuple):
            line = {"name": line[0], "total": line[1]}
        items.append({"shares": [{"user_id": actor.id}], **line})
    body = {
        "title": "Shop",
        "payer_id": actor.id,
        "spent_at": str(spent_at),
        "split_mode": "items",
        "shop_id": shop_id,
        "items": items,
    }
    url = f"/api/teams/{team}/expenses"
    response = (
        client.put(f"{url}/{expense_id}", json=body, headers=actor.headers)
        if expense_id
        else client.post(url, json=body, headers=actor.headers)
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


def _products(client, team, actor, **params):
    response = client.get(f"/api/teams/{team}/products", params=params, headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _product(client, team, actor, product_id):
    response = client.get(f"/api/teams/{team}/products/{product_id}", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def _review(client, team, actor, change, decision, **extra):
    response = client.post(
        f"/api/teams/{team}/prices/review",
        json={
            "decisions": [
                {
                    "product_id": change["product_id"],
                    "shop_id": change["shop_id"],
                    "observed_on": change["observed_on"],
                    "price": change["price"],
                    "regular_price": change["regular_price"],
                    "decision": decision,
                    **extra,
                }
            ]
        },
        headers=actor.headers,
    )
    assert response.status_code == 204, response.text


def _at(product, shop):
    return next(row for row in product["prices"] if row["shop_id"] == shop["id"])


# ------------------------------------------------------------------ names


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("Пятёрочка", "ПЯТЕРОЧКА"),
        ('ООО "Агроторг"', "агроторг"),
        ("  Lenta, LLC ", "lenta"),
    ],
)
def test_shop_names_compare_without_case_punctuation_or_legal_form(a, b):
    assert shop_key(a) == shop_key(b)


def test_product_names_compare_across_scripts_and_punctuation():
    assert name_key("Молоко 2,5% 930мл") == name_key("молоко 2.5 % 930МЛ")
    assert name_key("Ёжик_мармелад") == "ежик мармелад"
    assert name_key("—") == ""


def test_price_per_unit_comes_from_what_was_paid():
    assert paid_per_unit(433_32, Decimal("0.482")) == 899_00
    assert paid_per_unit(300_00, Decimal(3)) == 100_00
    assert paid_per_unit(99_90, Decimal(0)) == 99_90


# ------------------------------------------------------------------ shops


def test_shop_names_are_unique_however_they_are_written(client, team, alice, bob):
    _shop(client, team, alice, "Пятёрочка")
    duplicate = client.post(
        f"/api/teams/{team}/shops", json={"name": "ПЯТЕРОЧКА"}, headers=bob.headers
    )
    assert duplicate.status_code == 409
    shops = client.get(f"/api/teams/{team}/shops", headers=bob.headers).json()
    assert [shop["name"] for shop in shops] == ["Пятёрочка"]


def test_a_printed_name_belongs_to_one_shop(client, team, alice):
    first = _shop(client, team, alice, "Pyaterochka", alias='ООО "Агроторг"')
    assert first["aliases"] == ['ООО "Агроторг"']
    second = _shop(client, team, alice, "Perekrestok")
    moved = client.post(
        f"/api/teams/{team}/shops/{second['id']}/aliases",
        json={"alias": "АГРОТОРГ"},
        headers=alice.headers,
    )
    assert moved.status_code == 200
    assert moved.json()["aliases"] == ["АГРОТОРГ"]
    shops = {
        s["id"]: s for s in client.get(f"/api/teams/{team}/shops", headers=alice.headers).json()
    }
    assert shops[first["id"]]["aliases"] == []

    clash = client.post(
        f"/api/teams/{team}/shops/{second['id']}/aliases",
        json={"alias": "pyaterochka"},
        headers=alice.headers,
    )
    assert clash.status_code == 409


def test_shops_and_goods_stay_inside_their_team(client, team, alice, bob):
    shop = _shop(client, team, alice, "Lenta")
    bought = _buy(client, team, alice, shop["id"], [("Milk", 100_00)])
    product_id = bought["items"][0]["product_id"]

    other = client.post("/api/teams", json={"name": "Elsewhere"}, headers=bob.headers).json()["id"]
    assert client.get(f"/api/teams/{other}/shops", headers=bob.headers).json() == []
    assert _products(client, other, bob)["items"] == []
    assert (
        client.get(f"/api/teams/{other}/products/{product_id}", headers=bob.headers).status_code
        == 404
    )
    response = client.post(
        f"/api/teams/{other}/expenses",
        json={
            "title": "Sneaky",
            "payer_id": bob.id,
            "spent_at": str(TODAY),
            "split_mode": "items",
            "shop_id": shop["id"],
            "items": [{"name": "Milk", "total": 1, "shares": [{"user_id": bob.id}]}],
        },
        headers=bob.headers,
    )
    assert response.status_code == 422
    response = client.post(
        f"/api/teams/{other}/expenses",
        json={
            "title": "Sneaky",
            "payer_id": bob.id,
            "spent_at": str(TODAY),
            "split_mode": "items",
            "items": [
                {
                    "name": "Milk",
                    "total": 1,
                    "product_id": product_id,
                    "shares": [{"user_id": bob.id}],
                }
            ],
        },
        headers=bob.headers,
    )
    assert response.status_code == 422


def test_deleting_a_shop_keeps_its_expenses(client, team, alice, session):
    shop = _shop(client, team, alice, "Lenta")
    bought = _buy(client, team, alice, shop["id"], [("Milk", 100_00)])
    response = client.delete(f"/api/teams/{team}/shops/{shop['id']}", headers=alice.headers)
    assert response.status_code == 204
    expense = session.get(Expense, uuid.UUID(bought["id"]))
    assert expense is not None and expense.shop_id is None
    product = _product(client, team, alice, bought["items"][0]["product_id"])
    assert product["prices"] == []
    assert product["purchase_count"] == 1


# ------------------------------------------------------------ tracking


def test_first_purchase_records_each_price_without_asking(client, team, alice):
    shop = _shop(client, team, alice, "Lenta")
    bought = _buy(
        client,
        team,
        alice,
        shop["id"],
        [
            {"name": "МОЛ ПРОСТОКВ 2,5% 930", "total": 89_90, "product_name": "Молоко 2,5%"},
            {"name": "Bananas", "total": 120_00, "quantity": "1.5"},
            {"name": "Bag", "total": 9_00, "track": False},
        ],
    )
    assert bought["shop_id"] == shop["id"]
    assert bought["price_changes"] == []
    milk, bananas, bag = bought["items"]
    assert bag["product_id"] is None

    products = {p["name"]: p for p in _products(client, team, alice, sort="name")["items"]}
    assert set(products) == {"Молоко 2,5%", "Bananas"}
    assert products["Молоко 2,5%"]["id"] == milk["product_id"]
    assert products["Bananas"]["best_price"] == 80_00  # per kilogram
    assert products["Bananas"]["best_shop_id"] == shop["id"]
    row = _at(products["Молоко 2,5%"], shop)
    assert (row["price"], row["regular_price"], row["regular_on"]) == (89_90, 89_90, str(TODAY))
    assert row["last_paid"] == 89_90

    detail = _product(client, team, alice, bananas["product_id"])
    assert detail["history"][0]["price"] == 80_00
    assert detail["history"][0]["shop_name"] == "Lenta"
    assert detail["aliases"] == [{"shop_id": shop["id"], "shop_name": "Lenta", "name": "Bananas"}]


def test_nothing_is_tracked_without_a_shop_or_line_items(client, team, alice):
    _buy(client, team, alice, None, [("Milk", 100_00)])
    response = client.post(
        f"/api/teams/{team}/expenses",
        json={
            "title": "Dinner",
            "payer_id": alice.id,
            "spent_at": str(TODAY),
            "total": 500_00,
            "shares": [{"user_id": alice.id}],
        },
        headers=alice.headers,
    )
    assert response.status_code == 201
    assert _products(client, team, alice)["total_count"] == 0


def test_a_shop_prints_a_line_the_same_way_so_the_next_receipt_links_it(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    first = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "MLK PRSTK 2.5", "total": 89_90, "product_name": "Milk"}],
    )
    again = _buy(client, team, alice, lenta["id"], [("mlk prstk 2,5", 89_90)])
    assert again["items"][0]["product_id"] == first["items"][0]["product_id"]
    assert again["price_changes"] == []
    assert _products(client, team, alice)["total_count"] == 1


def test_a_name_in_another_case_lands_on_the_same_product(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    pyat = _shop(client, team, alice, "Pyaterochka")
    first = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "MLK 930", "total": 95_00, "product_name": "молоко простоквашино 2,5%"}],
    )
    # Another shop, another till text, and the model shouts the name this time.
    second = _buy(
        client,
        team,
        alice,
        pyat["id"],
        [{"name": "МОЛ ПРСТК", "total": 85_00, "product_name": "МОЛОКО ПРОСТОКВАШИНО 2.5 %"}],
    )
    assert second["items"][0]["product_id"] == first["items"][0]["product_id"]
    [product] = _products(client, team, alice)["items"]
    assert product["name"] == "молоко простоквашино 2,5%"  # the first spelling is kept
    assert len(product["prices"]) == 2
    # Creating it by hand in yet another case is refused as the same product.
    response = client.post(
        f"/api/teams/{team}/products",
        json={"name": "Молоко Простоквашино 2,5%"},
        headers=alice.headers,
    )
    assert response.status_code == 409


def test_relinking_a_line_by_hand_teaches_the_shop(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    milk = _buy(client, team, alice, lenta["id"], [("Milk", 89_90)])["items"][0]["product_id"]
    wrong = _buy(client, team, alice, lenta["id"], [("MLK 2.5", 91_00)])
    assert wrong["items"][0]["product_id"] != milk
    fixed = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "MLK 2.5", "total": 91_00, "product_id": milk}],
        expense_id=wrong["id"],
    )
    assert fixed["items"][0]["product_id"] == milk
    later = _buy(client, team, alice, lenta["id"], [("MLK 2.5", 91_00)])
    assert later["items"][0]["product_id"] == milk


# --------------------------------------------------------- price review


def test_a_new_price_asks_and_updating_replaces_the_saved_one(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Milk", 89_90)], spent_at=TODAY - timedelta(days=7))
    bought = _buy(client, team, alice, lenta["id"], [("Milk", 99_90)])
    [change] = bought["price_changes"]
    assert change["shop_name"] == "Lenta"
    assert (change["price"], change["saved_price"], change["on_sale"]) == (99_90, 89_90, False)

    # Unanswered, it waits on the goods page rather than being lost.
    waiting = _products(client, team, alice, filter="changed")["items"]
    assert [p["id"] for p in waiting] == [change["product_id"]]
    assert waiting[0]["pending"][0]["price"] == 99_90

    _review(client, team, alice, change, "regular")
    product = _product(client, team, alice, change["product_id"])
    row = _at(product, lenta)
    assert (row["price"], row["regular_price"], row["regular_on"]) == (99_90, 99_90, str(TODAY))
    assert product["pending"] == []


def test_keeping_the_old_price_stops_asking_about_that_receipt(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Milk", 89_90)], spent_at=TODAY - timedelta(days=7))
    bought = _buy(client, team, alice, lenta["id"], [("Milk", 129_90)])
    [change] = bought["price_changes"]
    _review(client, team, alice, change, "keep")

    product = _product(client, team, alice, change["product_id"])
    assert _at(product, lenta)["price"] == 89_90
    assert _at(product, lenta)["last_paid"] == 129_90
    assert product["pending"] == []
    # Saving the same expense again does not ask again.
    resaved = _buy(client, team, alice, lenta["id"], [("Milk", 129_90)], expense_id=bought["id"])
    assert resaved["price_changes"] == []


def test_an_old_receipt_entered_late_does_not_roll_a_price_back(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Milk", 99_90)])
    late = _buy(client, team, alice, lenta["id"], [("Milk", 79_90)], spent_at=TODAY - timedelta(30))
    assert late["price_changes"] == []
    product = _products(client, team, alice)["items"][0]
    assert _at(product, lenta)["price"] == 99_90
    assert product["pending"] == []


def test_the_same_good_twice_on_one_receipt_asks_once(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Milk", 89_90)], spent_at=TODAY - timedelta(days=1))
    bought = _buy(client, team, alice, lenta["id"], [("Milk", 99_90), ("Milk", 99_90)])
    assert len(bought["price_changes"]) == 1


# --------------------------------------------------------------- sales


def test_a_sale_runs_beside_the_regular_price_and_ends_by_itself(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    start = TODAY - timedelta(days=10)
    _buy(client, team, alice, lenta["id"], [("Coffee", 499_00)], spent_at=start)
    bought = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "Coffee", "total": 349_00, "on_sale": True, "regular_unit_price": 499_00}],
        spent_at=start + timedelta(days=1),
    )
    [change] = bought["price_changes"]
    assert change["on_sale"] is True
    assert change["regular_price"] == 499_00

    _review(client, team, alice, change, "sale", sale_until=str(TODAY + timedelta(days=3)))
    row = _at(_product(client, team, alice, change["product_id"]), lenta)
    assert row["on_sale"] is True
    assert (row["price"], row["regular_price"], row["sale_price"]) == (349_00, 499_00, 349_00)
    assert _products(client, team, alice, filter="sale")["total_count"] == 1

    # Left to the default, a sale lasts a week from the receipt -- long gone here.
    _review(client, team, alice, change, "sale")
    row = _at(_product(client, team, alice, change["product_id"]), lenta)
    assert row["on_sale"] is False
    assert row["price"] == 499_00
    assert row["sale_until"] == str(start + timedelta(days=8))
    assert _products(client, team, alice, filter="sale")["total_count"] == 0


def test_paying_the_sale_price_again_during_the_sale_does_not_ask(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Coffee", 499_00)], spent_at=TODAY - timedelta(days=2))
    sale = {"name": "Coffee", "total": 349_00, "on_sale": True}
    [change] = _buy(client, team, alice, lenta["id"], [sale], spent_at=TODAY - timedelta(days=1))[
        "price_changes"
    ]
    _review(client, team, alice, change, "sale")
    assert _buy(client, team, alice, lenta["id"], [sale])["price_changes"] == []


def test_paying_the_regular_price_after_a_sale_ends_it(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Coffee", 499_00)], spent_at=TODAY - timedelta(days=3))
    [sale] = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "Coffee", "total": 349_00, "on_sale": True}],
        spent_at=TODAY - timedelta(days=2),
    )["price_changes"]
    _review(client, team, alice, sale, "sale", sale_until=str(TODAY + timedelta(days=5)))
    [back] = _buy(client, team, alice, lenta["id"], [("Coffee", 529_00)])["price_changes"]
    _review(client, team, alice, back, "regular")
    row = _at(_product(client, team, alice, back["product_id"]), lenta)
    assert (row["price"], row["sale_price"], row["on_sale"]) == (529_00, None, False)


def test_a_first_sighting_on_sale_keeps_the_printed_regular_price(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    bought = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "Tea", "total": 150_00, "on_sale": True, "regular_unit_price": 200_00}],
    )
    assert bought["price_changes"] == []
    row = _at(_products(client, team, alice)["items"][0], lenta)
    assert (row["price"], row["sale_price"], row["regular_price"]) == (150_00, 150_00, 200_00)
    assert row["sale_until"] == str(TODAY + timedelta(days=7))


# ---------------------------------------------------------- comparison


def test_goods_compare_across_shops_cheapest_first(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    pyat = _shop(client, team, alice, "Пятёрочка")
    milk = _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "MOLOKO", "total": 95_00, "product_name": "Milk"}],
    )["items"][0]["product_id"]
    # A different till prints it differently; the model's name brings it together.
    linked = _buy(
        client,
        team,
        alice,
        pyat["id"],
        [{"name": "МОЛОКО 2.5", "total": 85_00, "product_name": "milk"}, ("Bread", 50_00)],
    )
    assert linked["items"][0]["product_id"] == milk

    product = _product(client, team, alice, milk)
    assert [row["shop_name"] for row in product["prices"]] == ["Пятёрочка", "Lenta"]
    assert (product["best_price"], product["best_shop_id"]) == (85_00, pyat["id"])
    assert [p["name"] for p in _products(client, team, alice, filter="compared")["items"]] == [
        "Milk"
    ]
    assert _products(client, team, alice, shop_id=lenta["id"])["total_count"] == 1
    assert _products(client, team, alice, sort="spread")["items"][0]["id"] == milk
    bread = linked["items"][1]["product_id"]
    # The expense form asks for exactly the goods on its lines, as repeated ids.
    picked = _products(client, team, alice, ids=[milk, bread])["items"]
    assert {p["id"] for p in picked} == {milk, bread}
    assert [p["id"] for p in _products(client, team, alice, ids=[bread])["items"]] == [bread]


def test_search_finds_goods_by_any_word_in_any_case_or_by_the_printed_name(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(
        client,
        team,
        alice,
        lenta["id"],
        [
            {"name": "МОЛ ПРОСТОКВ 2,5%", "total": 89_90, "product_name": "Молоко Простоквашино"},
            ("Хлеб Бородинский", 60_00),
        ],
    )
    names = lambda q: [p["name"] for p in _products(client, team, alice, q=q)["items"]]  # noqa: E731
    assert names("молоко") == ["Молоко Простоквашино"]
    assert names("ПРОСТОКВАШИНО МОЛ") == ["Молоко Простоквашино"]
    assert names("простокв 2,5") == ["Молоко Простоквашино"]  # the printed name
    assert names("бородинский") == ["Хлеб Бородинский"]
    assert names("кефир") == []
    assert len(names("")) == 2


def test_merging_duplicates_brings_their_shops_together(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    pyat = _shop(client, team, alice, "Pyaterochka")
    a = _buy(
        client, team, alice, lenta["id"], [("Milk Prostokvashino", 95_00)], TODAY - timedelta(2)
    )
    b = _buy(client, team, alice, pyat["id"], [("Moloko PRSTKV", 85_00)])
    keep, dup = a["items"][0]["product_id"], b["items"][0]["product_id"]
    _buy(client, team, alice, lenta["id"], [{"name": "Milk", "total": 99_00, "product_id": dup}])

    response = client.post(
        f"/api/teams/{team}/products/{dup}/merge", json={"into_id": keep}, headers=alice.headers
    )
    assert response.status_code == 200, response.text
    merged = response.json()
    assert merged["purchase_count"] == 3
    # Both had a Lenta price; the more recent one survives.
    assert _at(merged, lenta)["price"] == 99_00
    assert _at(merged, pyat)["price"] == 85_00
    assert {alias["name"] for alias in merged["aliases"]} >= {"Moloko PRSTKV", "Milk"}
    assert client.get(f"/api/teams/{team}/products/{dup}", headers=alice.headers).status_code == 404
    # The next Pyaterochka receipt links straight to the merged product.
    again = _buy(client, team, alice, pyat["id"], [("Moloko PRSTKV", 85_00)])
    assert again["items"][0]["product_id"] == keep


def test_a_price_seen_on_a_shelf_can_be_set_by_hand(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    metro = _shop(client, team, alice, "Metro")
    product = _buy(client, team, alice, lenta["id"], [("Rice", 120_00)])["items"][0]["product_id"]
    url = f"/api/teams/{team}/products/{product}/prices/{metro['id']}"

    response = client.put(
        url,
        json={
            "regular_price": 110_00,
            "sale_price": 90_00,
            "sale_until": str(TODAY + timedelta(days=2)),
            "observed_on": str(TODAY),
        },
        headers=alice.headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["best_shop_id"] == metro["id"]
    assert _at(response.json(), metro)["price"] == 90_00

    ended = client.put(
        url, json={"regular_price": 110_00, "observed_on": str(TODAY)}, headers=alice.headers
    ).json()
    assert _at(ended, metro)["price"] == 110_00
    assert _at(ended, metro)["on_sale"] is False

    bad = client.put(url, json={"observed_on": str(TODAY)}, headers=alice.headers)
    assert bad.status_code == 422

    assert client.delete(url, headers=alice.headers).status_code == 204
    assert [row["shop_id"] for row in _product(client, team, alice, product)["prices"]] == [
        lenta["id"]
    ]


def test_renaming_into_an_existing_name_is_refused(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    bought = _buy(client, team, alice, lenta["id"], [("Milk", 1_00), ("Kefir", 2_00)])
    kefir = bought["items"][1]["product_id"]
    url = f"/api/teams/{team}/products/{kefir}"
    assert client.patch(url, json={"name": "MILK"}, headers=alice.headers).status_code == 409
    renamed = client.patch(url, json={"name": "Kefir 1%"}, headers=alice.headers)
    assert renamed.json()["name"] == "Kefir 1%"


def test_deleting_a_product_unlinks_its_lines(client, team, alice, session):
    lenta = _shop(client, team, alice, "Lenta")
    bought = _buy(client, team, alice, lenta["id"], [("Milk", 1_00)])
    product = bought["items"][0]["product_id"]
    url = f"/api/teams/{team}/products/{product}"
    assert client.delete(url, headers=alice.headers).status_code == 204
    expense = client.get(f"/api/teams/{team}/expenses/{bought['id']}", headers=alice.headers)
    assert expense.json()["items"][0]["product_id"] is None
    assert session.scalars(select(Expense)).one().shop_id is not None


# ------------------------------------------------------------- savings


def _savings(client, team, actor):
    response = client.get(f"/api/teams/{team}/prices/savings", headers=actor.headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_full_price_at_the_only_known_shop_saves_nothing(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(client, team, alice, lenta["id"], [("Milk", 90_00), ("Bread", 50_00)])
    body = _savings(client, team, alice)
    assert (body["saved"], body["extra"], body["compared"], body["purchases"]) == (0, 0, 2, 2)


def test_a_cheaper_shop_saves_and_a_dearer_one_costs_against_the_average(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    pyat = _shop(client, team, alice, "Pyaterochka")
    day = TODAY - timedelta(days=3)
    _buy(client, team, alice, lenta["id"], [("Milk", 100_00)], spent_at=day)
    _buy(client, team, alice, pyat["id"], [{"name": "Milk", "total": 160_00, "quantity": "2"}])
    # Usual milk is (100 + 80) / 2 = 90: Lenta cost 10 over, two at Pyaterochka 20 under.
    body = _savings(client, team, alice)
    assert (body["saved"], body["extra"], body["on_sale"]) == (20_00, 10_00, 0)
    assert body["best"][0]["name"] == "Milk"
    assert body["best"][0]["saved"] == 10_00  # net over both purchases
    assert body["days"] == [
        {"date": str(day), "total": -10_00, "expense_count": 1},
        {"date": str(TODAY), "total": 20_00, "expense_count": 1},
    ]


def test_a_sale_saves_against_the_printed_regular_price(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    _buy(
        client,
        team,
        alice,
        lenta["id"],
        [{"name": "Coffee", "total": 349_00, "on_sale": True, "regular_unit_price": 499_00}],
    )
    body = _savings(client, team, alice)
    assert (body["saved"], body["on_sale"], body["extra"]) == (150_00, 150_00, 0)
    assert body["days"] == [{"date": str(TODAY), "total": 150_00, "expense_count": 1}]


def test_old_prices_do_not_turn_inflation_into_savings(client, team, alice):
    lenta = _shop(client, team, alice, "Lenta")
    pyat = _shop(client, team, alice, "Pyaterochka")
    # A year ago Pyaterochka sold it for 50; today Lenta sells it for 100.
    _buy(client, team, alice, pyat["id"], [("Milk", 50_00)], spent_at=TODAY - timedelta(days=365))
    _buy(client, team, alice, lenta["id"], [("Milk", 100_00)])
    body = _savings(client, team, alice)
    assert (body["saved"], body["extra"]) == (0, 0)


def test_purchases_without_a_shop_are_not_counted(client, team, alice):
    _buy(client, team, alice, None, [("Milk", 100_00)])
    assert _savings(client, team, alice)["purchases"] == 0
