# Tricount but better

Shared expenses for people who live together — with the part every other app
gets wrong: **you can split a shop receipt line by line.** One person pays at
the till, then the chicken goes to the two people who eat chicken and the
napkins go to everyone.

Photograph the receipt, and Claude reads it into editable line items.

---

## What it does

- **Teams** — a flat, a trip, a household. Invite links, owners and members.
- **Balances** — who is up, who is down, and the shortest set of payments that
  clears everything. Mark a payment as made and it settles.
- **Three ways to add an expense**
  1. a total split evenly,
  2. a total split across chosen people, optionally with weights,
  3. line by line — typed in, or read off a photographed receipt.
- **Receipt scanning** — one or more photos go to Claude, which returns
  structured line items. Everyone is on every line by default; tap a name off a
  line and they stop paying towards it.
- **Categories** and a spending breakdown.
- Works on a phone and on a desktop; light and dark.

## How it is built

| | |
|---|---|
| Backend | FastAPI, SQLAlchemy 2, Alembic, SQLite |
| Frontend | React 19, Vite, TypeScript, Tailwind v4 |
| Auth | JWT access/refresh, Argon2 password hashing |
| Receipt parsing | `claude-agent-sdk` with structured output, or the Messages API |
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
cp .env.example .env          # the defaults are fine for local work
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

The parser authenticates with `CLAUDE_CODE_OAUTH_TOKEN`. For local work you can
instead borrow whatever the Claude Code CLI is already logged in as:

```bash
# .env
CLAUDE_USE_AMBIENT_LOGIN=true
```

That flag is deliberately off by default — a server should fail loudly rather
than run on some operator's personal credentials.

Check the whole path, including proxy settings, without touching the UI:

```bash
uv run python scripts/check_vlm.py              # synthetic receipt
uv run python scripts/check_vlm.py photo.jpg    # your own
```

## Tests

```bash
uv run pytest                       # 60 tests, in-memory SQLite, no network
uv run ruff check src tests scripts
cd frontend && npx tsc -b --noEmit && npx eslint . && npm run build
```

No test calls a real model: the parser sits behind a `Protocol`, and the suite
substitutes a fake, so the conversion, status and failure paths are all covered
offline.

## Deploying

The server is the interesting part — including how to get model traffic out of a
region where `api.anthropic.com` is blocked, and which GitHub secrets to create.
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
├── images.py       upload validation, EXIF stripping, re-encoding
├── routers/        auth, teams, invites, categories, expenses, receipts
└── vlm/            the receipt parser — schema, prompt, two providers
frontend/src/
├── lib/            API client, money formatting (mirrors money.py)
├── components/     UI primitives, charts, team tabs, receipt scanner
└── pages/          login, register, teams, team detail, expense form
```
