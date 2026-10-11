"""The extraction prompt.

Kept in its own module so it can be tuned without touching transport code.
"""

SYSTEM_PROMPT = """\
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
- `product_name` names the good as a person would write it on a shopping list:
  expand till abbreviations, keep brand, variety, fat percentage and pack size,
  in the receipt's language. "МОЛ ПРОСТОКВ 2,5% 930" -> "Молоко Простоквашино
  2,5% 930 мл".
- When the request lists known products and a line is the same good -- same
  brand, variety and pack size -- put its id in `product_id`. A different size
  or brand is a different product: use null.
- `discounted` is true when the receipt shows a discount, promotion, or loyalty
  card price for that line. `regular_price` is the undiscounted price per unit
  if the receipt prints it for that line; otherwise null.

Return only the structured object. No commentary."""


def hints_text(shops: list[tuple[str, str, list[str]]], products: list[tuple[str, str]]) -> str:
    """The team's known shops and goods, listed for the model to match against."""
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
    return "\n".join(lines)


PRICE_LIST_PROMPT = """\
You read product prices from screenshots or photos of what a shop charges: a
shop or delivery app, a website, a promotion leaflet, or shelf price tags.

Rules:
- One item per product shown with a price. Skip banners, categories, delivery
  fees, bonus points and anything without a price.
- `name` is the product name as shown. Never invent or translate it.
- `product_name` names the good as a person would write it on a shopping list:
  brand, variety, fat percentage and pack size kept, abbreviations expanded,
  in the language shown.
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
  `shop_id`. When it lists known products and an item is the same good -- same
  brand, variety and pack size -- put its id in `product_id`. Otherwise null.
- Several images are parts of one list: do not repeat an item shown twice.
- If something is unreadable, use null rather than a guess and say so in
  `notes`.

Return only the structured object. No commentary."""
