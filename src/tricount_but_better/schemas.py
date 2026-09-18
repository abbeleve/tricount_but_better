"""Request and response models.

Money convention: **every monetary field in the API is an integer in minor
units** (kopecks, cents), in both directions. There is exactly one place that
turns a human "1234.56" into 123456 -- the client's formatter -- and exactly one
currency exponent table on each side. Decimal strings never cross the wire.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from .models import ExpenseSource, ReceiptStatus, SplitMode, TeamRole


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- auth


class RegisterIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=256)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"


class UserOut(ORMModel):
    id: uuid.UUID
    email: EmailStr
    display_name: str


# -------------------------------------------------------------------------- teams


class TeamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    currency: str = Field(default="RUB", min_length=3, max_length=3)


class TeamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)


class MemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: EmailStr
    role: TeamRole
    default_weight: Decimal


class MemberUpdate(BaseModel):
    role: TeamRole | None = None
    default_weight: Decimal | None = Field(default=None, ge=0)


class TeamOut(BaseModel):
    id: uuid.UUID
    name: str
    currency: str
    created_at: datetime
    member_count: int
    # This user's net position in the team, so the list screen needs no N+1.
    my_balance: int


class TeamDetailOut(BaseModel):
    id: uuid.UUID
    name: str
    currency: str
    created_at: datetime
    members: list[MemberOut]
    my_role: TeamRole


# ------------------------------------------------------------------------ invites


class InviteCreate(BaseModel):
    expires_in_days: int | None = Field(default=14, ge=1, le=365)
    max_uses: int | None = Field(default=None, ge=1, le=100)


class InviteOut(BaseModel):
    id: uuid.UUID
    code: str
    team_id: uuid.UUID
    expires_at: datetime | None
    max_uses: int | None
    use_count: int
    revoked: bool


class InvitePreviewOut(BaseModel):
    """What a recipient sees before committing to join."""

    team_name: str
    member_count: int
    currency: str


# --------------------------------------------------------------------- categories


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="", max_length=8)
    color: str = Field(default="", max_length=9)


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    emoji: str | None = Field(default=None, max_length=8)
    color: str | None = Field(default=None, max_length=9)
    is_archived: bool | None = None


class CategoryOut(ORMModel):
    id: uuid.UUID
    name: str
    emoji: str
    color: str
    is_archived: bool


# ----------------------------------------------------------------------- expenses


class ShareIn(BaseModel):
    user_id: uuid.UUID
    weight: Decimal = Field(default=Decimal(1), ge=0)


class ItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    total: int = Field(description="Line total in minor units.")
    quantity: Decimal = Field(default=Decimal(1), ge=0)
    unit_price: int = 0
    category_id: uuid.UUID | None = None
    shares: list[ShareIn] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_participants(self) -> Self:
        seen = {s.user_id for s in self.shares}
        if len(seen) != len(self.shares):
            raise ValueError(f"'{self.name}' lists the same person twice")
        if all(s.weight == 0 for s in self.shares):
            raise ValueError(f"'{self.name}' has no participant with a non-zero weight")
        return self


class ExpenseBase(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    payer_id: uuid.UUID
    spent_at: date
    note: str = Field(default="", max_length=2000)
    category_id: uuid.UUID | None = None
    split_mode: SplitMode = SplitMode.total
    total: int | None = Field(
        default=None, description="Total in minor units. Ignored when split_mode is 'items'."
    )
    shares: list[ShareIn] = Field(default_factory=list)
    items: list[ItemIn] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_mode(self) -> Self:
        if self.split_mode is SplitMode.total:
            if self.total is None:
                raise ValueError("a total-split expense needs a total")
            if not self.shares:
                raise ValueError("a total-split expense needs at least one participant")
            if self.items:
                raise ValueError("a total-split expense cannot carry line items")
            seen = {s.user_id for s in self.shares}
            if len(seen) != len(self.shares):
                raise ValueError("the same person is listed twice")
            if all(s.weight == 0 for s in self.shares):
                raise ValueError("at least one participant needs a non-zero weight")
        else:
            if not self.items:
                raise ValueError("an itemised expense needs at least one line")
            if self.shares:
                raise ValueError("an itemised expense derives its shares from its lines")
        return self


class ExpenseCreate(ExpenseBase):
    receipt_id: uuid.UUID | None = None


class ExpenseUpdate(ExpenseBase):
    pass


class ShareOut(BaseModel):
    user_id: uuid.UUID
    amount: int
    weight: Decimal | None = None


class ExpenseItemOut(BaseModel):
    id: uuid.UUID
    name: str
    quantity: Decimal
    unit_price: int
    total: int
    category_id: uuid.UUID | None
    shares: list[ShareOut]


class ExpenseOut(BaseModel):
    id: uuid.UUID
    team_id: uuid.UUID
    title: str
    note: str
    currency: str
    total: int
    spent_at: date
    payer_id: uuid.UUID
    category_id: uuid.UUID | None
    split_mode: SplitMode
    source: ExpenseSource
    receipt_id: uuid.UUID | None
    created_at: datetime
    shares: list[ShareOut]
    items: list[ExpenseItemOut]


class ExpenseListOut(BaseModel):
    items: list[ExpenseOut]
    total_count: int


# ----------------------------------------------------------------------- balances


class BalanceOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    net: int


class TransferOut(BaseModel):
    from_user_id: uuid.UUID
    to_user_id: uuid.UUID
    amount: int


class BalancesOut(BaseModel):
    currency: str
    balances: list[BalanceOut]
    transfers: list[TransferOut]
    total_spend: int


class CategoryTotalOut(BaseModel):
    category_id: uuid.UUID | None
    name: str
    emoji: str
    total: int


# -------------------------------------------------------------------- settlements


class SettlementCreate(BaseModel):
    from_user_id: uuid.UUID
    to_user_id: uuid.UUID
    amount: int = Field(gt=0)
    settled_at: date
    note: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _distinct(self) -> Self:
        if self.from_user_id == self.to_user_id:
            raise ValueError("a settlement needs two different people")
        return self


class SettlementOut(ORMModel):
    id: uuid.UUID
    from_user_id: uuid.UUID
    to_user_id: uuid.UUID
    amount: int
    currency: str
    note: str
    settled_at: date
    created_at: datetime


# ----------------------------------------------------------------------- receipts


class ParsedItemOut(BaseModel):
    name: str
    quantity: Decimal | None
    unit_price: int | None
    total: int


class ReceiptOut(BaseModel):
    id: uuid.UUID
    status: ReceiptStatus
    error: str | None = None
    merchant: str | None = None
    purchased_at: date | None = None
    currency: str | None = None
    items: list[ParsedItemOut] = Field(default_factory=list)
    # The grand total the model read off the paper, for the user to sanity-check
    # against the sum of the lines. The ledger always uses the sum of the lines.
    parsed_total: int | None = None
    items_total: int = 0
    notes: str | None = None
