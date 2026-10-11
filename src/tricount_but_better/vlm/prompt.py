"""The extraction prompt.

Kept in its own module so it can be tuned without touching transport code.
"""

# How every good is described, on receipts and price lists alike. The levels go
# from general to specific so that the same good reads the same everywhere,
# however a till cuts or codes its name; the app matches goods on them.
LEVELS_RULES = """\
- Describe each good in levels, from general to specific, so that the same
  good reads the same everywhere, however it is printed. Leave out what is not
  the good itself: a marking tag such as "[M+]" or "[M]" and the code digits
  after it, an article number, and unit markers such as "КГ" or "ШТ".
- `kind`: what the good is, as a generic noun phrase from a shopping list,
  lower case, in the language shown, without brand, flavour or size: "хлеб",
  "молоко", "бананы", "салфетки влажные".
- `variety`: what sets it apart within its kind -- type, flavour, fat
  percentage, colour, cut, purpose: "белый нарезной", "2,5%", "клубника".
  Null if none is named.
- `brand`: the brand or producer if shown, written out in full when it is
  abbreviated ("ПРОСТОКВ" -> "Простоквашино"); a shop's own label counts
  ("Лента"). Null if none is shown. Never guess one.
- `size_amount` and `size_unit` (g, kg, ml, l or pcs): the pack size in the
  name: "350Г" -> "350" and "g", "0,93Л" -> "0.93" and "l", "10ШТ" -> "10" and
  "pcs". Both null when no pack size is shown, and for goods sold by weight.
- `by_weight`: true when the good is sold by weight and priced per kilogram.
- `product_name`: all of it as one readable name a person would write on a
  shopping list, in the language shown: "МОЛ ПРОСТОКВ 2,5% 930" -> "Молоко
  Простоквашино 2,5% 930 мл".
- When the request lists kinds the team already uses, reuse one exactly when
  it names the same kind of good; otherwise write a new one.
- When the request lists known products and an item is the same good -- same
  brand, variety and pack size -- put its id in `product_id`. A different size
  or brand is a different product: use null."""

SYSTEM_PROMPT = f"""\
You extract structured data from photographs of shop and restaurant receipts.

Rules:
- Transcribe `name` exactly as printed. Never invent, translate, or tidy it up;
  the readable version goes in `product_name`.
- One output item per printed line. Do not merge duplicates or split bundles.
- Amounts are decimal strings with a dot separator and no currency symbol
  ("249.90", not "249,90 RUB").
- A line's `total` is what the customer was charged for that line, after any
  line-level discount that is printed against it.
- Weighted goods: put the weight in `quantity` and the price per unit in
  `unit_price` ("0.482" kg at "899.00").
- Do not infer a missing quantity or unit price from the line total. Use null
  unless the value is printed.
- Skip non-product lines entirely: subtotals, change, loyalty points, VAT
  summaries, card footers, "thank you" text.
- If several images are given, they are pages of ONE receipt, in order. Merge
  them into a single item list and do not repeat lines that span a page break.
- If a value is unreadable, use null rather than a guess, and say what was
  unreadable in `notes`. Do not add commentary about dates or inferred values.

Shop:
- `merchant` is the seller exactly as printed, often a legal entity
  ('ООО "Агроторг"'). `shop_name` is the name customers know the shop by,
  its brand or sign ("Пятёрочка"); null if the receipt does not show it.
- When the request lists known shops and the receipt is clearly from one of
  them (by name, brand, legal entity or address), put its id in `shop_id`.
  Otherwise null. Do not pick the closest one when unsure.

Products:
{LEVELS_RULES}
- `discounted` is true when the receipt shows a discount, promotion, or loyalty
  card price for that line. `regular_price` is the undiscounted price per unit
  if the receipt prints it for that line; otherwise null.

Return only the structured object. No commentary."""


def hints_text(
    shops: list[tuple[str, str, list[str]]],
    products: list[tuple[str, str]],
    kinds: list[str] | None = None,
) -> str:
    """The team's known shops, goods and kinds of goods, listed for the model to
    match against."""
    lines = []
    if shops:
        lines.append("Known shops (id: name; other printed names):")
        lines += [
            f"{ref}: {name}" + (f"; {'; '.join(aliases)}" if aliases else "")
            for ref, name, aliases in shops
        ]
    else:
        lines.append("Known shops: none yet, so shop_id is null.")
    if products:
        lines.append("Known products (id: name):")
        lines += [f"{ref}: {name}" for ref, name in products]
    else:
        lines.append("Known products: none yet, so every product_id is null.")
    if kinds:
        lines.append("Kinds the team already uses: " + "; ".join(kinds))
    return "\n".join(lines)


PRICE_LIST_PROMPT = f"""\
You read product prices from screenshots or photos of what a shop charges: a
shop or delivery app, a website, a promotion leaflet, or shelf price tags.

Rules:
- One item per product shown with a price. Skip banners, categories, delivery
  fees, bonus points and anything without a price.
- `name` is the product name as shown. Never invent or translate it.
- `price` is what the shop asks now: per piece, or per kilogram for goods sold
  by weight. If only a price per 100 g is shown, multiply it by 10.
- `regular_price` is a crossed-out, "old" or "without card" price shown beside
  the current one; null if there is none. Never compute one.
- `sale_until` is a promotion end date shown for that item or for the whole
  page, as YYYY-MM-DD; null if none is shown. A date without a year ("до
  20.10") is the next such date on or after today's date given in the request.
- Amounts are decimal strings with a dot separator and no currency symbol.
- `shop_name` is the shop or chain the prices are from, as customers know it
  (app header, logo text, price tag); null if it is not shown. When the request
  lists known shops and the prices are clearly from one of them, put its id in
  `shop_id`. Otherwise null.
- Several images are parts of one list: do not repeat an item shown twice.
- If something is unreadable, use null rather than a guess and say so in
  `notes`.

Products:
{LEVELS_RULES}

Return only the structured object. No commentary."""
