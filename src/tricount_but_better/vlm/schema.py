"""The contract between the vision model and the rest of the app.

``RECEIPT_JSON_SCHEMA`` is handed to the model as a structured-output schema, so
the response is machine-checkable rather than prose we have to regex. Amounts
travel as decimal *strings* -- JSON numbers are IEEE floats and would quietly
corrupt prices before they ever reached ``money.to_minor``.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Self

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

log = logging.getLogger(__name__)

# A value that is missing or unreadable is an empty string, never null, in
# every field: one rule for the model, and no field needs a union type, which
# Claude's structured outputs allow only 16 of per request. The parsers read ""
# as none.

# A good described in levels, general to specific. Shared by receipts and price
# lists, and placed right after the printed name: the model writes the levels
# before the readable name, so the name follows from them.
LEVEL_PROPERTIES: dict = {
    "kind": {
        "type": "string",
        "description": "What the good is, generic and lower case: 'хлеб', 'бананы'.",
    },
    "variety": {
        "type": "string",
        "description": "Type, flavour, fat %, colour, cut or purpose within the kind; '' if none.",
    },
    "brand": {
        "type": "string",
        "description": "Brand or producer, written out in full; '' if not printed.",
    },
    "size_amount": {
        "type": "string",
        "description": "Pack size as a decimal string, e.g. '350' or '0.93'; '' if none.",
    },
    "size_unit": {
        "type": "string",
        "description": "Unit of the pack size: g, kg, ml, l or pcs; '' if none.",
    },
    "by_weight": {"type": "boolean", "description": "Sold by weight, priced per kilogram."},
}

RECEIPT_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "merchant",
        "shop_name",
        "shop_address",
        "shop_id",
        "purchased_at",
        "currency",
        "items",
        "subtotal",
        "discount",
        "total",
        "notes",
    ],
    "properties": {
        "merchant": {
            "type": "string",
            "description": "Seller name exactly as printed, often a legal entity; '' if none.",
        },
        "shop_name": {
            "type": "string",
            "description": (
                "The name customers know the shop by -- its brand or sign, "
                "e.g. 'Пятёрочка' rather than 'ООО \"Агроторг\"'; '' if not shown."
            ),
        },
        "shop_address": {
            "type": "string",
            "description": "Store address as printed, or ''.",
        },
        "shop_id": {
            "type": "string",
            "description": "Id of the known shop the receipt is from, or ''.",
        },
        "purchased_at": {
            "type": "string",
            "description": "Purchase date as YYYY-MM-DD; '' if not printed.",
        },
        "currency": {
            "type": "string",
            "description": "ISO 4217 code, e.g. RUB, USD, EUR; '' if unclear.",
        },
        "items": {
            "type": "array",
            "description": "One entry per purchased line. Never merge or invent lines.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    *LEVEL_PROPERTIES,
                    "quantity",
                    "unit_price",
                    "total",
                    "product_name",
                    "product_id",
                    "discounted",
                    "regular_price",
                ],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name as printed, original language; '' if unreadable.",
                    },
                    **LEVEL_PROPERTIES,
                    "product_name": {
                        "type": "string",
                        "description": (
                            "The product as a person would write it on a shopping list: "
                            "abbreviations expanded; brand, variety and pack size kept; "
                            "same language as the receipt."
                        ),
                    },
                    "product_id": {
                        "type": "string",
                        "description": "Id of the same known product, or ''.",
                    },
                    "discounted": {
                        "type": "boolean",
                        "description": "A discount, promo or loyalty price applies.",
                    },
                    "regular_price": {
                        "type": "string",
                        "description": "Undiscounted unit price if printed, else ''.",
                    },
                    "quantity": {
                        "type": "string",
                        "description": "Decimal string, e.g. '1' or '0.482'; '' if not printed.",
                    },
                    "unit_price": {
                        "type": "string",
                        "description": "Decimal string, no currency sign; '' if not printed.",
                    },
                    "total": {
                        "type": "string",
                        "description": "Line total as a decimal string, e.g. '249.90', or ''.",
                    },
                },
            },
        },
        "subtotal": {"type": "string", "description": "Decimal string, or ''."},
        "discount": {
            "type": "string",
            "description": "Total discount as a positive decimal string, or ''.",
        },
        "total": {
            "type": "string",
            "description": "Grand total actually paid, as a decimal string, or ''.",
        },
        "notes": {
            "type": "string",
            "description": "Anything unreadable or ambiguous the human should check, or ''.",
        },
    },
}


_SPACES = re.compile(r"\s+")
_NUMBER = re.compile(r"[-+]?\d(?:[\d.,]*\d)?")
_DOTTED_DATE = re.compile(r"(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b")


def _to_decimal(value: object) -> Decimal | None:
    """A decimal the model wrote, or None.

    Models slip into an amount what the prompt says to leave out, more often
    deep into a long receipt: a currency sign or unit ("249.90 ₽", "0,482кг"),
    a decimal comma, thousands separators ("1 199,00", "1,199.00"). Those are
    read. Text with no number, or with two ("2 x 49.90"), is unreadable rather
    than guessed at.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float | Decimal):
        text = str(value)
    elif isinstance(value, str):
        numbers = _NUMBER.findall(_SPACES.sub("", value).replace("−", "-"))
        if len(numbers) != 1:
            return None
        text = numbers[0]
        marks = [c for c in text if c in ".,"]
        if marks:
            # The last mark is the decimal point unless it repeats; the others
            # separate thousands. Receipts in ru/de locales use a comma.
            point = marks[-1]
            if marks.count(point) > 1:
                text = text.replace(",", "").replace(".", "")
            else:
                text = text.replace("," if point == "." else ".", "").replace(point, ".")
    else:
        return None
    try:
        dec = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    return dec if dec.is_finite() else None


def _text(v: object) -> object:
    """Blank or non-string answers become None rather than failing the parse."""
    if v is None or not isinstance(v, str | int):
        return None
    text = str(v).strip()
    return text or None


def _flag(v: object) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def _to_date(value: object) -> date | None:
    """A date the model wrote, or None: a bad date must not sink the whole parse.

    ISO is asked for; a date copied as printed ("01.09.2026") is read too.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        pass
    if dotted := _DOTTED_DATE.match(text):
        day, month, year = dotted.groups()
        try:
            return date(int(year) + (2000 if len(year) == 2 else 0), int(month), int(day))
        except ValueError:
            return None
    return None


def _readable_lines(lines: object, model: type[_Line]) -> list:
    """The lines that can be read, each on its own: one malformed line drops
    out instead of failing every other line of a long receipt, and so does one
    with neither a name nor an amount."""
    if not isinstance(lines, list):
        return []
    readable = []
    for line in lines:
        try:
            parsed = model.model_validate(line)
        except ValidationError:
            log.warning("dropped a scanned %s that could not be read", model.__name__)
            continue
        if parsed.name or parsed.amount is not None:
            readable.append(parsed)
    return readable


class ParsedLevels(BaseModel):
    """The levels the model wrote for one good; ``catalog.levels_from`` checks them."""

    kind: str | None = None
    variety: str | None = None
    brand: str | None = None
    size_amount: Decimal | None = None
    size_unit: str | None = None
    by_weight: bool = False

    @field_validator("kind", "variety", "brand", "size_unit", mode="before")
    @classmethod
    def _coerce_level(cls, v: object) -> object:
        return _text(v)

    @field_validator("size_amount", mode="before")
    @classmethod
    def _coerce_size(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("by_weight", mode="before")
    @classmethod
    def _coerce_weighed(cls, v: object) -> object:
        return _flag(v)


class _Line(ParsedLevels):
    """A good on a receipt or price list. Without a printed name it goes by its
    readable one; with neither it stays blank for a person to fill in."""

    name: str = ""
    product_name: str | None = None
    product_id: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _coerce_name(cls, v: object) -> object:
        return _text(v) or ""

    @field_validator("product_name", "product_id", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @model_validator(mode="after")
    def _named(self) -> Self:
        if not self.name and self.product_name:
            self.name = self.product_name
        return self

    @property
    def amount(self) -> Decimal | None:
        raise NotImplementedError


class ParsedItem(_Line):
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    # None when unreadable: the line is still shown, and the expense cannot be
    # saved until a person enters its amount. Dropping it would quietly leave
    # it out of the total.
    total: Decimal | None = None
    discounted: bool = False
    regular_price: Decimal | None = None

    @field_validator("quantity", "unit_price", "total", "regular_price", mode="before")
    @classmethod
    def _coerce(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("discounted", mode="before")
    @classmethod
    def _coerce_flag(cls, v: object) -> object:
        return _flag(v)

    @property
    def amount(self) -> Decimal | None:
        return self.total


class ParsedReceipt(BaseModel):
    merchant: str | None = None
    shop_name: str | None = None
    shop_address: str | None = None
    shop_id: str | None = None
    purchased_at: date | None = None
    currency: str | None = None
    items: list[ParsedItem] = Field(default_factory=list)
    subtotal: Decimal | None = None
    discount: Decimal | None = None
    total: Decimal | None = None
    notes: str | None = None

    @field_validator("items", mode="before")
    @classmethod
    def _coerce_items(cls, v: object) -> object:
        return _readable_lines(v, ParsedItem)

    @field_validator("subtotal", "discount", "total", mode="before")
    @classmethod
    def _coerce_money(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("merchant", "shop_name", "shop_address", "shop_id", "notes", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @field_validator("purchased_at", mode="before")
    @classmethod
    def _coerce_date(cls, v: object) -> object:
        return _to_date(v)

    @field_validator("currency", mode="before")
    @classmethod
    def _coerce_currency(cls, v: object) -> object:
        if not v:
            return None
        code = str(v).strip().upper()
        return code if len(code) == 3 and code.isalpha() else None

    @property
    def items_total(self) -> Decimal:
        return sum((i.total for i in self.items if i.total is not None), Decimal(0))


# ------------------------------------------------------------------ price lists

PRICE_LIST_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["shop_name", "shop_address", "shop_id", "currency", "items", "notes"],
    "properties": {
        "shop_name": {
            "type": "string",
            "description": "The shop or chain the prices are from, as customers know it, or ''.",
        },
        "shop_address": {"type": "string", "description": "Store address if shown, or ''."},
        "shop_id": {
            "type": "string",
            "description": "Id of the known shop these prices are from, or ''.",
        },
        "currency": {
            "type": "string",
            "description": "ISO 4217 code, e.g. RUB; '' if unclear.",
        },
        "items": {
            "type": "array",
            "description": "One entry per product shown with a price.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    *LEVEL_PROPERTIES,
                    "product_name",
                    "product_id",
                    "price",
                    "regular_price",
                    "sale_until",
                ],
                "properties": {
                    "name": {"type": "string", "description": "Product name as shown."},
                    **LEVEL_PROPERTIES,
                    "product_name": {
                        "type": "string",
                        "description": "Readable shopping-list name: brand, variety, pack size.",
                    },
                    "product_id": {
                        "type": "string",
                        "description": "Id of the same known product, or ''.",
                    },
                    "price": {
                        "type": "string",
                        "description": "Price now, per piece or per kg if weighed, or ''.",
                    },
                    "regular_price": {
                        "type": "string",
                        "description": "Crossed-out or old price shown beside it, or ''.",
                    },
                    "sale_until": {
                        "type": "string",
                        "description": "Promotion end date as YYYY-MM-DD, or ''.",
                    },
                },
            },
        },
        "notes": {
            "type": "string",
            "description": "Anything unreadable or ambiguous the human should check, or ''.",
        },
    },
}


class ParsedPrice(_Line):
    price: Decimal | None = None
    regular_price: Decimal | None = None
    sale_until: date | None = None

    @field_validator("price", "regular_price", mode="before")
    @classmethod
    def _coerce_money(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("sale_until", mode="before")
    @classmethod
    def _coerce_date(cls, v: object) -> object:
        return _to_date(v)

    @property
    def amount(self) -> Decimal | None:
        return self.price


class ParsedPriceList(BaseModel):
    shop_name: str | None = None
    shop_address: str | None = None
    shop_id: str | None = None
    currency: str | None = None
    items: list[ParsedPrice] = Field(default_factory=list)
    notes: str | None = None

    @field_validator("items", mode="before")
    @classmethod
    def _coerce_items(cls, v: object) -> object:
        return _readable_lines(v, ParsedPrice)

    @field_validator("shop_name", "shop_address", "shop_id", "notes", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @field_validator("currency", mode="before")
    @classmethod
    def _coerce_currency(cls, v: object) -> object:
        if not v:
            return None
        code = str(v).strip().upper()
        return code if len(code) == 3 and code.isalpha() else None
