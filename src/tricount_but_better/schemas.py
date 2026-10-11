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
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints, model_validator

from .models import ExpenseSource, NotificationKind, ReceiptStatus, SplitMode, TeamRole


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


# --------------------------------------------------------------------- appearance

HexColor = Annotated[
    str, StringConstraints(strip_whitespace=True, to_lower=True, pattern=r"^#[0-9a-fA-F]{6}$")
]
PaletteId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")]
PaletteName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
UnitFloat = Annotated[float, Field(allow_inf_nan=False)]

MAX_PALETTES = 12


class Palette(BaseModel):
    """Two colours the whole glass look is derived from."""

    id: PaletteId
    name: PaletteName
    base: HexColor
    accent: HexColor


class Appearance(BaseModel):
    """A user's look. Every field has a default, so a partial or older blob still loads.

    ``palette`` names a built-in palette (the client owns that list) or one of
    ``palettes``; an unknown id falls back to the default on the client.
    """

    glass: bool = False
    palette: PaletteId = "mint"
    palettes: list[Palette] = Field(default_factory=list, max_length=MAX_PALETTES)
    glow: UnitFloat = Field(default=1.0, ge=0, le=2)  # backdrop glow strength
    blur: int = Field(default=18, ge=0, le=40)  # frost radius in px; 0 = plain fill
    fill: int = Field(default=55, ge=20, le=95)  # panel opacity in %
    backdrop_seed: int = Field(default=0, ge=0, le=0xFFFFFFFF)  # 0 = hand-placed glows
    flow: bool = False  # the glows drift
    flow_speed: UnitFloat = Field(default=1.0, ge=0.25, le=4)
    flow_range: UnitFloat = Field(default=1.0, ge=0.5, le=2)

    @model_validator(mode="after")
    def _unique_palette_ids(self) -> Self:
        ids = [palette.id for palette in self.palettes]
        if len(ids) != len(set(ids)):
            raise ValueError("palette ids must be unique")
        return self


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    display_name: str
    appearance: Appearance = Field(default_factory=Appearance)


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


CategoryName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]


class CategoryCreate(BaseModel):
    name: CategoryName
    emoji: str = Field(default="", max_length=8)
    color: str = Field(default="", max_length=9)


class CategoryUpdate(BaseModel):
    name: CategoryName | None = None
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
    # Price tracking, used when the expense has a shop. Without a product the
    # line is matched to one, or a product is created named ``product_name``
    # (else the line's own name). ``track=False`` keeps a line out of it.
    product_id: uuid.UUID | None = None
    product_name: str | None = Field(default=None, max_length=200)
    track: bool = True
    on_sale: bool = False
    regular_unit_price: int | None = Field(default=None, gt=0)

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
    shop_id: uuid.UUID | None = None
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
    product_id: uuid.UUID | None = None
    on_sale: bool = False
    regular_unit_price: int | None = None


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
    shop_id: uuid.UUID | None = None
    split_mode: SplitMode
    source: ExpenseSource
    receipt_id: uuid.UUID | None
    created_at: datetime
    shares: list[ShareOut]
    items: list[ExpenseItemOut]
    # Only on a create or update: receipt prices that differ from what the shop's
    # price was saved as, for the person who saved it to accept or dismiss.
    price_changes: list[PriceChangeOut] = Field(default_factory=list)


class ExpenseListOut(BaseModel):
    items: list[ExpenseOut]
    total_count: int


# ---------------------------------------------------------------- shops and goods

ShopName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
ProductName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
PriceDecision = Literal["regular", "sale", "keep"]


class ShopCreate(BaseModel):
    name: ShopName
    address: str = Field(default="", max_length=240)
    # The name a scanned receipt printed, remembered so the next one matches.
    # Generous on input and cut to 120 when stored: a printed legal name can be
    # long, and refusing it would fail the shop rather than shorten an alias.
    alias: str | None = Field(default=None, max_length=1000)


class ShopUpdate(BaseModel):
    name: ShopName | None = None
    address: str | None = Field(default=None, max_length=240)


class ShopAliasIn(BaseModel):
    alias: str = Field(min_length=1, max_length=1000)


class ShopOut(BaseModel):
    id: uuid.UUID
    name: str
    address: str
    aliases: list[str]
    product_count: int = Field(description="Goods with a saved price at this shop.")
    last_visit: date | None


class ProductCreate(BaseModel):
    name: ProductName


class ProductUpdate(BaseModel):
    name: ProductName


class ProductMerge(BaseModel):
    into_id: uuid.UUID


class ShopPriceOut(BaseModel):
    """One product at one shop. Prices are per unit, in minor units."""

    shop_id: uuid.UUID
    shop_name: str
    price: int | None = Field(description="Today's price there: a running sale, else regular.")
    regular_price: int | None
    regular_on: date | None
    sale_price: int | None
    sale_on: date | None
    sale_until: date | None
    on_sale: bool = Field(description="A sale is running today.")
    last_paid: int | None = None
    last_paid_on: date | None = None
    last_paid_on_sale: bool = False


class PriceChangeOut(BaseModel):
    """A receipt price that differs from the one saved for that shop."""

    product_id: uuid.UUID
    product_name: str
    shop_id: uuid.UUID
    shop_name: str
    observed_on: date
    price: int
    on_sale: bool = Field(description="The line was marked as discounted.")
    regular_price: int | None = Field(description="Undiscounted price printed on the receipt.")
    saved_price: int | None = Field(description="The shop's price for that day before this.")
    saved_on_sale: bool


class PricePointOut(BaseModel):
    expense_id: uuid.UUID
    shop_id: uuid.UUID | None
    shop_name: str | None
    spent_at: date
    price: int
    quantity: Decimal
    on_sale: bool


class ProductAliasOut(BaseModel):
    shop_id: uuid.UUID
    shop_name: str
    name: str


class ProductOut(BaseModel):
    id: uuid.UUID
    name: str
    prices: list[ShopPriceOut] = Field(description="Cheapest first; shops with no price last.")
    best_price: int | None
    best_shop_id: uuid.UUID | None
    last_bought_on: date | None
    purchase_count: int
    pending: list[PriceChangeOut]


class ProductListOut(BaseModel):
    items: list[ProductOut]
    total_count: int


class ProductDetailOut(ProductOut):
    history: list[PricePointOut]
    aliases: list[ProductAliasOut]


class ShopPriceIn(BaseModel):
    """What a shop charges, set by hand -- seen on a shelf, or corrected.

    Replaces what is saved: leave ``sale_price`` out to end a sale.
    """

    regular_price: int | None = Field(default=None, gt=0)
    sale_price: int | None = Field(default=None, gt=0)
    sale_until: date | None = None
    observed_on: date

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.regular_price is None and self.sale_price is None:
            raise ValueError("give a regular price, a sale price, or both")
        if self.sale_until is not None:
            if self.sale_price is None:
                raise ValueError("a sale end date needs a sale price")
            if self.sale_until < self.observed_on:
                raise ValueError("a sale cannot end before it was seen")
        return self


class PriceDecisionIn(BaseModel):
    """An answer to "this receipt has a new price -- update it?"."""

    product_id: uuid.UUID
    shop_id: uuid.UUID
    observed_on: date
    price: int = Field(gt=0)
    regular_price: int | None = Field(default=None, gt=0)
    decision: PriceDecision
    sale_until: date | None = None

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.sale_until is not None and self.sale_until < self.observed_on:
            raise ValueError("a sale cannot end before it was seen")
        return self


class PriceReviewIn(BaseModel):
    decisions: list[PriceDecisionIn] = Field(min_length=1, max_length=200)


class ScannedPriceOut(BaseModel):
    """One good read off a price screenshot, matched to the team's catalogue."""

    name: str = Field(description="As shown.")
    product_name: str | None = None
    product_id: uuid.UUID | None = None
    product_match: Literal["receipt", "model", "name"] | None = None
    price: int | None = Field(description="Per piece or per kg; None if unreadable.")
    regular_price: int | None = Field(description="A crossed-out or old price shown beside it.")
    sale_until: date | None = None


class PriceScanIn(BaseModel):
    images: list[str] = Field(min_length=1)
    # The viewer's date, so "until 20.10" without a year resolves the right way.
    today: date | None = None


class PriceScanOut(BaseModel):
    shop: ShopMatchOut
    currency: str
    items: list[ScannedPriceOut]
    notes: str | None = None


class ListedPriceIn(BaseModel):
    name: str = Field(min_length=1, max_length=200, description="As shown; remembered per shop.")
    product_id: uuid.UUID | None = None
    product_name: str | None = Field(default=None, max_length=200)
    price: int = Field(gt=0)
    regular_price: int | None = Field(default=None, gt=0)
    sale_until: date | None = None


class PriceImportIn(BaseModel):
    """Prices someone read off a shop's app, site, leaflet or shelf, and checked."""

    shop_id: uuid.UUID
    observed_on: date
    items: list[ListedPriceIn] = Field(min_length=1, max_length=300)

    @model_validator(mode="after")
    def _check(self) -> Self:
        for item in self.items:
            if item.sale_until is not None and item.sale_until < self.observed_on:
                raise ValueError(f"the sale on '{item.name}' ends before the prices were seen")
        return self


class PriceImportOut(BaseModel):
    saved: int = Field(description="Prices saved.")
    created: int = Field(description="Of those, goods that were new to the team.")


class SavingsDayOut(BaseModel):
    """One purchase date, shaped like ``DailySpendingOut`` so the same charts draw it."""

    date: date
    total: int = Field(description="Saved minus paid over usual that day; negative if over.")
    expense_count: int = Field(description="Purchases compared that day.")


class SavingsProductOut(BaseModel):
    product_id: uuid.UUID
    name: str
    saved: int


class SavingsOut(BaseModel):
    """What tracked purchases cost against each good's usual price at the time.

    The usual price is each known shop's regular price nearest the purchase
    date (within 90 days), averaged over shops. ``saved`` sums the purchases
    that came in under it, ``extra`` those that came in over it (as a positive
    amount); ``on_sale`` is the part of ``saved`` from discounted lines.
    """

    currency: str
    saved: int
    extra: int
    on_sale: int
    compared: int = Field(description="Purchases with a usual price to compare with.")
    purchases: int = Field(description="Purchases at a known shop, linked to a product.")
    days: list[SavingsDayOut]
    best: list[SavingsProductOut] = Field(description="Goods that saved the most, up to five.")


# --------------------------------------------------------------- planned expenses


class PlannedItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    total: int | None = Field(default=None, ge=0)


class PlannedExpenseIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    note: str = Field(default="", max_length=2000)
    category_id: uuid.UUID | None = None
    items: list[PlannedItemIn] = Field(min_length=1)


class PlannedExpenseOut(PlannedExpenseIn):
    id: uuid.UUID
    team_id: uuid.UUID
    created_at: datetime


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


class DailySpendingOut(BaseModel):
    date: date
    total: int
    expense_count: int


class SpendingOut(BaseModel):
    currency: str
    days: list[DailySpendingOut]


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


# ------------------------------------------------------------------ notifications


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: NotificationKind
    created_at: datetime
    read: bool
    team_id: uuid.UUID
    team_name: str
    actor_id: uuid.UUID | None
    actor_name: str | None
    expense_id: uuid.UUID | None
    # Snapshot of the expense as it was added; amounts in minor units.
    title: str
    total: int
    currency: str
    share: int = Field(description="The recipient's part of the total; 0 if not in on it.")


class NotificationListOut(BaseModel):
    items: list[NotificationOut]
    unread_count: int


class NotificationsRead(BaseModel):
    """Mark these as read, or everything when ``ids`` is left out."""

    ids: list[uuid.UUID] | None = Field(default=None, max_length=500)


class UnreadOut(BaseModel):
    unread_count: int


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=255)
    auth: str = Field(min_length=1, max_length=255)


class PushSubscriptionIn(BaseModel):
    """The browser's ``PushSubscription.toJSON()``, plus the language to write in."""

    endpoint: str = Field(min_length=1, max_length=2048)
    keys: PushKeys
    language: Literal["en", "ru"] = "en"


class PushSubscriptionRemove(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)


# ----------------------------------------------------------------------- receipts


class ParsedItemOut(BaseModel):
    name: str
    quantity: Decimal | None
    unit_price: int | None
    total: int
    # A readable name for the good, for a new product; the model writes it.
    product_name: str | None = None
    product_id: uuid.UUID | None = None
    # "receipt": this shop printed this line before and it was linked then.
    # "model": the model recognised a known product. "name": same name.
    product_match: Literal["receipt", "model", "name"] | None = None
    on_sale: bool = False
    regular_unit_price: int | None = None


class ShopMatchOut(BaseModel):
    """Which shop a receipt is from, or what to call it if it is a new one."""

    shop_id: uuid.UUID | None = None
    # "receipt": the printed name is a known shop's name or alias. "model": the
    # model recognised a known shop from the list it was given.
    matched_by: Literal["receipt", "model"] | None = None
    name: str | None = None
    address: str | None = None


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


class ReceiptScanOut(BaseModel):
    merchant: str | None = None
    shop: ShopMatchOut = Field(default_factory=ShopMatchOut)
    purchased_at: date | None = None
    currency: str | None = None
    items: list[ParsedItemOut]
    parsed_total: int | None = None
    items_total: int
    notes: str | None = None
