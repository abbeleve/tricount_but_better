#!/usr/bin/env python
"""Fill a running instance with a realistic three-person flat share.

Useful for looking at the UI with real numbers in it, and for a smoke test of
the whole API surface after a deploy.

    uv run python scripts/seed_demo.py [base_url]
"""

from __future__ import annotations

import sys
from datetime import date, timedelta

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
PASSWORD = "flat42-shared-costs"

PEOPLE = [
    ("andrey@example.com", "Andrey"),
    ("masha@example.com", "Masha"),
    ("dima@example.com", "Dima"),
]


def register_or_login(client: httpx.Client, email: str, name: str) -> dict:
    response = client.post(
        "/api/auth/register",
        json={"email": email, "display_name": name, "password": PASSWORD},
    )
    if response.status_code == 409:
        response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    response.raise_for_status()
    return response.json()


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=30) as client:
        actors = {}
        for email, name in PEOPLE:
            tokens = register_or_login(client, email, name)
            headers = {"Authorization": f"Bearer {tokens['access_token']}"}
            me = client.get("/api/auth/me", headers=headers).json()
            actors[name] = {"headers": headers, "id": me["id"]}
            print(f"user  {name:8} {me['id']}")

        owner = actors["Andrey"]

        team = client.post(
            "/api/teams", json={"name": "Flat 42", "currency": "RUB"}, headers=owner["headers"]
        ).json()
        team_id = team["id"]
        print(f"team  {team['name']} {team_id}")

        invite = client.post(
            f"/api/teams/{team_id}/invites", json={}, headers=owner["headers"]
        ).json()
        for name in ("Masha", "Dima"):
            client.post(
                f"/api/invites/{invite['code']}/accept", headers=actors[name]["headers"]
            ).raise_for_status()
            print(f"join  {name}")

        categories = {
            c["name"]: c["id"]
            for c in client.get(f"/api/teams/{team_id}/categories", headers=owner["headers"]).json()
        }

        everyone = [{"user_id": actors[n]["id"]} for n in ("Andrey", "Masha", "Dima")]
        today = date.today()

        def add(payload: dict, who: str = "Andrey") -> None:
            response = client.post(
                f"/api/teams/{team_id}/expenses", json=payload, headers=actors[who]["headers"]
            )
            response.raise_for_status()
            print(f"spend {payload['title']:24} {response.json()['total'] / 100:>10,.2f}")

        add(
            {
                "title": "Weekly shop",
                "payer_id": actors["Andrey"]["id"],
                "spent_at": str(today - timedelta(days=6)),
                "total": 4_820_50,
                "category_id": categories["Groceries"],
                "shares": everyone,
            }
        )
        add(
            {
                "title": "Electricity",
                "payer_id": actors["Masha"]["id"],
                "spent_at": str(today - timedelta(days=5)),
                "total": 3_140_00,
                "category_id": categories["Utilities"],
                "shares": everyone,
            },
            "Masha",
        )
        add(
            {
                "title": "Cleaning supplies",
                "payer_id": actors["Dima"]["id"],
                "spent_at": str(today - timedelta(days=4)),
                "total": 1_299_00,
                "category_id": categories["Household"],
                "shares": everyone,
            },
            "Dima",
        )
        # Two of three: Dima was away.
        add(
            {
                "title": "Taxi from the airport",
                "payer_id": actors["Andrey"]["id"],
                "spent_at": str(today - timedelta(days=3)),
                "total": 2_450_00,
                "category_id": categories["Transport"],
                "shares": [{"user_id": actors["Andrey"]["id"]}, {"user_id": actors["Masha"]["id"]}],
            }
        )

        def shop(name: str, alias: str) -> str:
            response = client.post(
                f"/api/teams/{team_id}/shops",
                json={"name": name, "alias": alias},
                headers=owner["headers"],
            )
            if response.status_code == 409:  # seeded before
                shops = client.get(f"/api/teams/{team_id}/shops", headers=owner["headers"])
                return next(s["id"] for s in shops.json() if s["name"] == name)
            response.raise_for_status()
            return response.json()["id"]

        pyaterochka = shop("Пятёрочка", 'ООО "Агроторг"')
        lenta = shop("Лента", 'ООО "Лента"')

        def line(name: str, product: str, total: int, shares: list, **extra) -> dict:
            return {
                "name": name,
                "product_name": product,
                "total": total,
                "shares": shares,
                **extra,
            }

        # Two weeks ago at Lenta: the same goods, mostly cheaper, coffee on sale.
        add(
            {
                "title": "Лента",
                "payer_id": actors["Masha"]["id"],
                "spent_at": str(today - timedelta(days=14)),
                "split_mode": "items",
                "shop_id": lenta,
                "category_id": categories["Groceries"],
                "items": [
                    line("МОЛОКО ПРОСТОКВ 3,2% 1Л", "Milk 3.2% 1 L", 94_90, everyone),
                    line("ХЛЕБ РЖАНОЙ", "Rye bread", 54_00, everyone),
                    line("САЛФЕТКИ БУМ 100ШТ", "Paper napkins 100 pcs", 79_90, everyone),
                    line(
                        "КОФЕ ЗЕРНО 1КГ",
                        "Coffee beans 1 kg",
                        1_199_00,
                        everyone,
                        on_sale=True,
                        regular_unit_price=1_599_00,
                    ),
                ],
            },
            "Masha",
        )
        # Ten days ago at Pyaterochka: the first prices seen there.
        add(
            {
                "title": "Пятёрочка",
                "payer_id": actors["Dima"]["id"],
                "spent_at": str(today - timedelta(days=10)),
                "split_mode": "items",
                "shop_id": pyaterochka,
                "category_id": categories["Groceries"],
                "items": [
                    line("Milk 3.2% 1L", "Milk 3.2% 1 L", 99_90, everyone),
                    line("Coffee beans 1kg", "Coffee beans 1 kg", 1_499_00, everyone),
                ],
            },
            "Dima",
        )
        # The reason this app exists: Masha does not eat chicken.
        chicken_eaters = [
            {"user_id": actors["Andrey"]["id"]},
            {"user_id": actors["Dima"]["id"]},
        ]
        add(
            {
                "title": "Pyaterochka",
                "payer_id": actors["Dima"]["id"],
                "spent_at": str(today - timedelta(days=1)),
                "split_mode": "items",
                "shop_id": pyaterochka,
                "category_id": categories["Groceries"],
                "items": [
                    line(
                        "Chicken breast 0.482 kg",
                        "Chicken breast",
                        433_32,
                        chicken_eaters,
                        quantity="0.482",
                    ),
                    line("Paper napkins 100pc", "Paper napkins 100 pcs", 89_90, everyone),
                    # Up from 99.90 ten days ago: waits under Prices as "price changed".
                    line("Milk 3.2% 1L", "Milk 3.2% 1 L", 104_50, everyone),
                    line("Rye bread", "Rye bread", 62_00, everyone),
                    {
                        "name": "Oat milk (Masha)",
                        "total": 189_00,
                        "shares": [{"user_id": actors["Masha"]["id"]}],
                    },
                ],
            },
            "Dima",
        )

        balances = client.get(f"/api/teams/{team_id}/balances", headers=owner["headers"]).json()
        print("\nbalances")
        for entry in balances["balances"]:
            print(f"  {entry['display_name']:8} {entry['net'] / 100:>+12,.2f}")
        print(f"  {'sum':8} {sum(b['net'] for b in balances['balances']) / 100:>+12,.2f}")
        print("\nsettle up")
        names = {a["id"]: n for n, a in actors.items()}
        for transfer in balances["transfers"]:
            print(
                f"  {names[transfer['from_user_id']]:8} -> "
                f"{names[transfer['to_user_id']]:8} {transfer['amount'] / 100:>10,.2f}"
            )
        print(f"\nopen  {BASE.replace('8000', '5173')}/teams/{team_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
