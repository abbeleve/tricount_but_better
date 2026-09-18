"""The contract between the vision model and the rest of the app.

``RECEIPT_JSON_SCHEMA`` is handed to the model as a structured-output schema, so
the response is machine-checkable rather than prose we have to regex. Amounts
travel as decimal *strings* -- JSON numbers are IEEE floats and would quietly
corrupt prices before they ever reached ``money.to_minor``.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation

from pydantic import BaseModel, Field, field_validator

RECEIPT_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "merchant": {
            "type": ["string", "null"],
            "description": "Shop or restaurant name exactly as printed.",
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
                "required": ["name", "total"],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Product name as printed, original language.",
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


class ParsedItem(BaseModel):
    name: str
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    total: Decimal

    @field_validator("quantity", "unit_price", "total", mode="before")
    @classmethod
    def _coerce(cls, v: object) -> object:
        return _to_decimal(v)


class ParsedReceipt(BaseModel):
    merchant: str | None = None
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

    @field_validator("purchased_at", mode="before")
    @classmethod
    def _coerce_date(cls, v: object) -> object:
        # A model that cannot read the date should not sink the whole parse.
        if v in (None, "", "null"):
            return None
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
