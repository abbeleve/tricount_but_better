# Tricount but better

Shared expenses for people who live together — with the part every other app
gets wrong: **you can split a shop receipt line by line.** One person pays at
the till, then the chicken goes to the two people who eat chicken and the
napkins go to everyone.

Photograph the receipt, and a vision model reads it into editable line items.

---

## What it does

- **Teams** — a flat, a trip, a household. Invite links, owners and members.
- **Balances** — who is up, who is down, and the shortest set of payments that
  clears everything. Mark a payment as made and it settles.
- **Line-by-line expenses** — enter each item and its price, or read the lines from a photographed receipt. Choose who shares each line. Existing total-split expenses open as a single editable line.
- **Receipt scanning** — one or more photos go to Polza, which returns
  structured line items. Photos and scan results are not stored by the app;
  only the lines you save as an expense persist. Everyone is on every line by
  default; tap a name off a line and they stop paying towards it.
- **Planned purchases** — keep a shopping list with optional prices. Finish the
  purchase through the expense form; plans do not affect balances.
- **Categories** and a spending breakdown.
- Works on a phone and on a desktop; light and dark. English and Russian can be selected from the account menu (or on the sign-in screen). The home screen shows how much you owe across teams, separated by currency.

## How it is built

| | |
|---|---|
| Backend | FastAPI, SQLAlchemy 2, Alembic, SQLite |
| Frontend | React 19, Vite, TypeScript, Tailwind v4 |
| Auth | JWT access/refresh, Argon2 password hashing |
| Receipt parsing | Polza OpenAI-compatible vision API (`qwen/qwen3.5-9b` by default) |
| Deploy | systemd + nginx, GitHub Actions |

### Money is never a float

Every amount is an integer in minor units (kopecks). Splits use the
largest-remainder method, so a three-way split of 100 ₽ is 34/33/33 and **not**
33/33/33 with a kopeck lost. `sum(shares) == total` is enforced on every write
and asserted in tests.

Item-level splits are the source of truth for an itemised expense; the per-user
totals the balance screen reads are recomputed from them on every write, so a
balance query never has to know which mode an expense used.

---

## Running it locally

Needs Python 3.13, Node 22 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --all-extras
cp .env.example .env          # then set POLZA_API_KEY for receipt scanning
uv run alembic upgrade head
uv run uvicorn tricount_but_better.main:app --reload
```

In a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173>. API docs are at <http://localhost:8000/docs>.

To look at it with realistic numbers in it:

```bash
uv run python scripts/seed_demo.py
```

### Receipt scanning locally

The parser sends receipt photos to Polza's vision API. Set your API key in the
ignored `.env` file:

```bash
# .env
VLM_MODEL=qwen/qwen3.5-9b
POLZA_API_KEY=pza_...
```

The key stays on the backend; the browser never receives it. On a computer,
use **Upload photos**. On a phone, use **Take a photo** or **Choose from gallery**.
You can add lines by hand first, then use **Add from receipt** to append scanned
lines to the same expense.

Check the whole path, including proxy settings, without touching the UI:

```bash
uv run python scripts/check_vlm.py              # synthetic receipt
uv run python scripts/check_vlm.py photo.jpg    # your own
```

## Tests

```bash
uv run pytest                       # in-memory SQLite, no network
uv run ruff check src tests scripts
cd frontend && npx tsc -b --noEmit && npx eslint . && npm run build
```

No test calls a real model: the parser sits behind a `Protocol`, and the suite
substitutes a fake, so the conversion, status and failure paths are all covered
offline.

## Deploying

The deployment guide covers model-provider availability and GitHub secrets.
See **[deploy/README.md](deploy/README.md)**.

```bash
sudo bash deploy/bootstrap.sh   # once, on the server
git push origin main            # every time after that
```

## Layout

```
src/tricount_but_better/
├── money.py        minor-unit arithmetic and the split algorithm
├── balances.py     net positions and debt simplification
├── services.py     keeps sum(shares) == total on every write
├── models.py       SQLAlchemy schema
├── images.py       in-memory validation, EXIF stripping, re-encoding
├── routers/        auth, teams, invites, categories, expenses, plans, receipts
└── vlm/            the receipt parser — schema, prompt, Polza provider
frontend/src/
├── lib/            API client, money formatting (mirrors money.py)
├── components/     UI primitives, charts, team tabs, receipt scanner
└── pages/          login, register, teams, team detail, expense and plan forms
```
