"""The contract between the vision model and the rest of the app.

``RECEIPT_JSON_SCHEMA`` is handed to the model as a structured-output schema, so
the response is machine-checkable rather than prose we have to regex. Amounts
travel as decimal *strings* -- JSON numbers are IEEE floats and would quietly
corrupt prices before they ever reached ``money.to_minor``.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, Field, field_validator

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
            "type": ["string", "null"],
            "description": "Seller name exactly as printed, often a legal entity.",
        },
        "shop_name": {
            "type": ["string", "null"],
            "description": (
                "The name customers know the shop by -- its brand or sign, "
                "e.g. 'Пятёрочка' rather than 'ООО \"Агроторг\"'. Null if not shown."
            ),
        },
        "shop_address": {
            "type": ["string", "null"],
            "description": "Store address as printed, or null.",
        },
        "shop_id": {
            "type": ["string", "null"],
            "description": "Id of the known shop the receipt is from, or null.",
        },
        "purchased_at": {
            "type": ["string", "null"],
            "description": "Purchase date as YYYY-MM-DD. Null if not printed.",
        },
        "currency": {
            "type": ["string", "null"],
            "description": "ISO 4217 code, e.g. RUB, USD, EUR. Null if unclear.",
        },
        "items": {
            "type": "array",
            "description": "One entry per purchased line. Never merge or invent lines.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
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
                        "description": "Product name as printed, original language.",
                    },
                    "product_name": {
                        "type": ["string", "null"],
                        "description": (
                            "The product as a person would write it on a shopping list: "
                            "abbreviations expanded; brand, variety and pack size kept; "
                            "same language as the receipt."
                        ),
                    },
                    "product_id": {
                        "type": ["string", "null"],
                        "description": "Id of the same known product, or null.",
                    },
                    "discounted": {
                        "type": "boolean",
                        "description": "A discount, promo or loyalty price applies.",
                    },
                    "regular_price": {
                        "type": ["string", "null"],
                        "description": "Undiscounted unit price, if printed.",
                    },
                    "quantity": {
                        "type": ["string", "null"],
                        "description": "Decimal string, e.g. '1' or '0.482'. Null if absent.",
                    },
                    "unit_price": {
                        "type": ["string", "null"],
                        "description": "Decimal string with a dot separator, no currency sign.",
                    },
                    "total": {
                        "type": "string",
                        "description": "Line total as a decimal string, e.g. '249.90'.",
                    },
                },
            },
        },
        "subtotal": {"type": ["string", "null"], "description": "Decimal string or null."},
        "discount": {
            "type": ["string", "null"],
            "description": "Total discount as a positive decimal string, or null.",
        },
        "total": {
            "type": ["string", "null"],
            "description": "Grand total actually paid, as a decimal string.",
        },
        "notes": {
            "type": ["string", "null"],
            "description": "Anything unreadable or ambiguous the human should check.",
        },
    },
}


def _to_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    text = str(value).strip().replace(" ", "").replace(" ", "")
    # Receipts printed in ru/de locales use a comma as the decimal separator.
    if "," in text and "." not in text:
        text = text.replace(",", ".")
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


class ParsedItem(BaseModel):
    name: str
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    total: Decimal
    product_name: str | None = None
    product_id: str | None = None
    discounted: bool = False
    regular_price: Decimal | None = None

    @field_validator("quantity", "unit_price", "total", "regular_price", mode="before")
    @classmethod
    def _coerce(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("product_name", "product_id", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @field_validator("discounted", mode="before")
    @classmethod
    def _coerce_flag(cls, v: object) -> object:
        return v is True or (isinstance(v, str) and v.strip().lower() == "true")


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

    @field_validator("subtotal", "discount", "total", mode="before")
    @classmethod
    def _coerce_money(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("shop_name", "shop_address", "shop_id", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @field_validator("purchased_at", mode="before")
    @classmethod
    def _coerce_date(cls, v: object) -> object:
        # A model that cannot read the date should not sink the whole parse.
        if v in (None, "", "null"):
            return None
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, str) and ("T" in v or " " in v):
            try:
                return datetime.fromisoformat(v.replace("Z", "+00:00")).date()
            except ValueError:
                pass
        return v

    @field_validator("currency", mode="before")
    @classmethod
    def _coerce_currency(cls, v: object) -> object:
        if not v:
            return None
        code = str(v).strip().upper()
        return code if len(code) == 3 and code.isalpha() else None

    @property
    def items_total(self) -> Decimal:
        return sum((i.total for i in self.items), Decimal(0))


# ------------------------------------------------------------------ price lists

PRICE_LIST_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["shop_name", "shop_address", "shop_id", "currency", "items", "notes"],
    "properties": {
        "shop_name": {
            "type": ["string", "null"],
            "description": "The shop or chain the prices are from, as customers know it.",
        },
        "shop_address": {"type": ["string", "null"], "description": "Store address if shown."},
        "shop_id": {
            "type": ["string", "null"],
            "description": "Id of the known shop these prices are from, or null.",
        },
        "currency": {
            "type": ["string", "null"],
            "description": "ISO 4217 code, e.g. RUB. Null if unclear.",
        },
        "items": {
            "type": "array",
            "description": "One entry per product shown with a price.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "name",
                    "product_name",
                    "product_id",
                    "price",
                    "regular_price",
                    "sale_until",
                ],
                "properties": {
                    "name": {"type": "string", "description": "Product name as shown."},
                    "product_name": {
                        "type": ["string", "null"],
                        "description": "Readable shopping-list name: brand, variety, pack size.",
                    },
                    "product_id": {
                        "type": ["string", "null"],
                        "description": "Id of the same known product, or null.",
                    },
                    "price": {
                        "type": "string",
                        "description": "Current price per piece, or per kg if sold by weight.",
                    },
                    "regular_price": {
                        "type": ["string", "null"],
                        "description": "Crossed-out or old price shown beside it, or null.",
                    },
                    "sale_until": {
                        "type": ["string", "null"],
                        "description": "Promotion end date as YYYY-MM-DD, or null.",
                    },
                },
            },
        },
        "notes": {
            "type": ["string", "null"],
            "description": "Anything unreadable or ambiguous the human should check.",
        },
    },
}


def _to_date(value: object) -> date | None:
    """A date the model wrote, or None: a bad date must not sink the whole parse."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


class ParsedPrice(BaseModel):
    name: str
    product_name: str | None = None
    product_id: str | None = None
    price: Decimal | None = None
    regular_price: Decimal | None = None
    sale_until: date | None = None

    @field_validator("price", "regular_price", mode="before")
    @classmethod
    def _coerce_money(cls, v: object) -> object:
        return _to_decimal(v)

    @field_validator("product_name", "product_id", mode="before")
    @classmethod
    def _coerce_text(cls, v: object) -> object:
        return _text(v)

    @field_validator("sale_until", mode="before")
    @classmethod
    def _coerce_date(cls, v: object) -> object:
        return _to_date(v)


class ParsedPriceList(BaseModel):
    shop_name: str | None = None
    shop_address: str | None = None
    shop_id: str | None = None
    currency: str | None = None
    items: list[ParsedPrice] = Field(default_factory=list)
    notes: str | None = None

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
