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
- **Spending analytics** — the Spending section in each team shows this week/month/year against the full previous period, a comparison chart, and history grouped by week, month, or year. Weeks start on Monday; totals use purchase dates and include refunds, excluding plans and paybacks.
- **Planned purchases** — keep a shopping list with optional prices. Finish the
  purchase through the expense form; plans do not affect balances.
- **Shops and prices** — say where an expense was bought, and every line's
  price is remembered for that shop. A scanned receipt is matched to one of the
  team's shops by the name it prints (or the model recognises it); an unknown
  shop is offered as a new one, and the printed name is remembered so the next
  receipt from there matches by itself. Under each line the form shows whether
  another shop sells it cheaper, and a card shows what the same items would
  have cost elsewhere. The **Prices** tab lists every good with its lowest price
  and where, searchable in any case and by the name a till printed; each good
  has a page with its price in every shop and a history of what was paid.
  *How price changes work:* the first price seen at a shop is saved. A later
  receipt with a different price asks whether it is the shop's **new price**,
  a **sale** (kept beside the regular price with an end date — a week unless
  you say — and the regular price returns by itself when it ends), or a one-off
  to **keep** the old price for. An old receipt entered late never rolls a
  price back. Unanswered questions wait on the Prices tab as "price changed".
  Shops name the same good differently, so two products can be **merged**.
  Prices can also be added and edited by hand — a price seen on a shelf, a
  correction, or a sale with its end date — and a product can be added without
  a receipt.
  *Prices from a screenshot:* **Prices → From screenshot** reads a shop's app or
  website, a promotion leaflet or photos of price tags. The model proposes the
  shop, each good, its current price, a crossed-out old price and a promotion
  end date; every row is checked and editable before **Save** stores them as
  that shop's prices (a higher old price makes it a sale). Nothing is bought,
  so no expense is added, and the names shown are remembered per shop so the
  next screenshot links the same goods by itself.
  *Savings:* each purchase is compared with that good's usual price at the time
  (every known shop's regular price nearest the purchase date, averaged).
  Coming in under it — a sale, or a cheaper shop — counts as saved; over it is
  shown too, never hidden. Full price at the usual shop counts as zero. The
  Prices tab shows the total, how much came from sales, and the Spending tab's
  own week/month/year chart for it. Price differences on single items are shown
  as information only; another shop is suggested only when a receipt would cost
  at least 10% less there across three or more items.
- **Team categories** — any member can create shared categories from the Categories tab or while entering an expense or planned purchase, with an optional emoji and a spending breakdown.
- **Notifications** — when someone adds an expense (or finishes a planned
  purchase), everyone else in the team hears about it: who added what, the
  total, and their own share. A bell in the header counts what is unread; the
  Notifications page lists it and marks it read. Turn on **Push notifications**
  there to get them on the phone's lock screen too — opt-in per device, written
  in the language that device uses, and tapping one opens the expense. On iPhone
  and iPad, push needs the app added to the Home Screen first (iOS 16.4+).
- Works on a phone and on a desktop; light and dark. English and Russian can be selected from the account menu (or on the sign-in screen). The home screen shows how much you owe across teams, separated by currency.
- **Glass design (optional)** — frosted, translucent panels over a soft backdrop
  of coloured glows, switched on under **Appearance** in the account menu. Pick
  a built-in palette or make your own from two colours, tune the glow strength,
  frost and panel opacity, shuffle the glow layout, and let the backdrop drift
  at the speed and range you like. The look is saved to your account, so it
  follows you to every device. Balance and spending colours never take the
  palette, so "owes" and "is owed" always stay distinguishable.

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
use **Upload photos**, drag receipt images into the scanner, or paste a copied
image with **Ctrl+V** / **⌘V** while the scanner is open. On a phone, use
**Take a photo**, **Choose from gallery**, or **Paste photo** to add an image
from the clipboard. If clipboard access is unavailable or denied, the scanner
provides a field for the native **Paste** action. All input methods add to the
same preview queue before **Read the receipt**; the image count and size limits
apply to each method.
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
cd frontend && npm test && npx tsc -b --noEmit && npx eslint . && npm run build
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
├── catalog.py      shops and goods: name matching, saved prices, sales, price review
├── notifications.py  who hears about a new expense, and push delivery
├── webpush.py      Web Push: VAPID signing and aes128gcm encryption (RFC 8291/8292)
├── models.py       SQLAlchemy schema
├── images.py       in-memory validation, EXIF stripping, re-encoding
├── routers/        auth, teams, invites, categories, expenses, plans, receipts, shops,
│                   products (goods and prices), price_scans (screenshots), notifications
└── vlm/            receipt and price-list reading — schemas, prompts, Polza provider
frontend/src/
├── lib/            API client, money formatting (mirrors money.py), price comparison,
│                   glass palettes
├── components/     UI primitives, charts, team tabs, receipt scanner, glass backdrop
├── pages/          login, register, teams, team detail, expense and plan forms, product
│                   prices, appearance, notifications
├── index.css       design tokens
└── glass.css       the optional glass look: retunes those tokens from a palette
```

The glass look never restyles a component directly. `useAppearance` puts a
`glass` class and the palette's two colours on `<html>`; `glass.css` derives
every other colour from them with `color-mix()` and retunes the app's own
tokens, so a screen that has never heard of glass still blends in. Panels frost
through a `::before` layer rather than `backdrop-filter` on the panel itself,
so anything `position: fixed` inside a panel still anchors to the window.
