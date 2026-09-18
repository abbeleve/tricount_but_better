"""The extraction prompt.

Kept in its own module so it can be tuned without touching transport code, and
so both providers send byte-identical instructions.
"""

SYSTEM_PROMPT = """\
You extract structured data from photographs of shop and restaurant receipts.

Rules:
- Transcribe what is printed. Never invent, translate, or tidy up product names.
- One output item per printed line. Do not merge duplicates or split bundles.
- Amounts are decimal strings with a dot separator and no currency symbol
  ("249.90", not "249,90 RUB").
- A line's `total` is what the customer was charged for that line, after any
  line-level discount that is printed against it.
- Weighted goods: put the weight in `quantity` and the price per unit in
  `unit_price` ("0.482" kg at "899.00").
- Skip non-product lines entirely: subtotals, change, loyalty points, VAT
  summaries, card footers, "thank you" text.
- If several images are given, they are pages of ONE receipt, in order. Merge
  them into a single item list and do not repeat lines that span a page break.
- If a value is unreadable, use null rather than a guess, and say what was
  unreadable in `notes`.

Return only the structured object. No commentary."""


def user_prompt(filenames: list[str]) -> str:
    listing = "\n".join(f"- {name}" for name in filenames)
    return (
        "Read every image file below from the current directory, then extract the "
        f"receipt into the required structure.\n\n{listing}\n\n"
        "Read all of them before answering."
    )
