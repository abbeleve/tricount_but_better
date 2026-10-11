#!/usr/bin/env python
"""Smoke-test the configured receipt parser.

Run this on the server after deploying. It exercises the Polza provider.

    uv run python scripts/check_vlm.py                 # synthetic receipt
    uv run python scripts/check_vlm.py photo1.jpg ...  # your own photos
"""

from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

from tricount_but_better.config import get_settings
from tricount_but_better.vlm import VlmError, VlmUnavailable, get_parser

SYNTHETIC_LINES = [
    ("Chicken breast 0.482 kg", "433.32"),
    ("Paper napkins 100pc", "89.90"),
    ("Milk 3.2% 1L", "104.50"),
    ("Rye bread", "62.00"),
]


def _synthetic_receipt() -> bytes:
    """Draw a plain receipt so the check needs no fixture files."""
    from PIL import Image, ImageDraw

    width, height = 520, 620
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.text((150, 30), "PYATEROCHKA", fill="black")
    draw.text((150, 55), "01.09.2026  14:32", fill="black")
    draw.line((30, 85, width - 30, 85), fill="black")

    y = 110
    for name, price in SYNTHETIC_LINES:
        draw.text((40, y), name, fill="black")
        draw.text((width - 110, y), price, fill="black")
        y += 40

    draw.line((30, y + 10, width - 30, y + 10), fill="black")
    draw.text((40, y + 30), "TOTAL", fill="black")
    draw.text((width - 110, y + 30), "689.72", fill="black")

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=95)
    return buffer.getvalue()


async def main() -> int:
    settings = get_settings()
    print("provider   : polza")
    print(f"model      : {settings.vlm_model}")
    print("base url   : https://polza.ai/api/v1")
    credential = "POLZA_API_KEY" if settings.effective_polza_api_key else "(none found)"
    print(f"credential : {credential}")
    print()

    if len(sys.argv) > 1:
        images = []
        for raw in sys.argv[1:]:
            source = Path(raw)
            if not source.exists():
                print(f"no such file: {source}")
                return 2
            images.append(source.read_bytes())
    else:
        print("no images given -- using a synthetic receipt\n")
        images = [_synthetic_receipt()]

    try:
        result = await get_parser(settings).parse(images)
    except VlmUnavailable as exc:
        print(f"UNAVAILABLE: {exc}")
        return 3
    except VlmError as exc:
        print(f"FAILED: {exc}")
        return 1

    receipt = result.receipt
    print(f"merchant   : {receipt.merchant}")
    print(f"shop       : {receipt.shop_name}  {receipt.shop_address or ''}".rstrip())
    print(f"date       : {receipt.purchased_at}")
    print(f"currency   : {receipt.currency}")
    print(f"printed    : {receipt.total}")
    print(f"line sum   : {receipt.items_total}")
    if result.cost_usd is not None:
        print(f"cost       : ${result.cost_usd}")
    print(f"\n{len(receipt.items)} items:")
    for item in receipt.items:
        quantity = f" x{item.quantity}" if item.quantity is not None else ""
        sale = f"  [sale, usually {item.regular_price}]" if item.discounted else ""
        print(f"  {item.total:>10}  {item.name}{quantity}{sale}")
        if item.product_name:
            print(f"{'':14}-> {item.product_name}")
    if receipt.notes:
        print(f"\nnotes: {receipt.notes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
