"""Creating, reading and editing expenses."""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from ..deps import CurrentUser, DbSession, Membership, TeamDep
from ..models import (
    Category,
    Expense,
    ExpenseItem,
    ExpenseSource,
    Receipt,
    SplitMode,
    TeamMember,
)
from ..schemas import (
    ExpenseCreate,
    ExpenseItemOut,
    ExpenseListOut,
    ExpenseOut,
    ExpenseUpdate,
    ShareOut,
)
from ..services import SplitError, apply_item_splits, apply_total_split, build_item_shares

router = APIRouter(prefix="/teams/{team_id}/expenses", tags=["expenses"])


def _member_ids(session: DbSession, team_id: uuid.UUID) -> set[uuid.UUID]:
    return set(
        session.scalars(select(TeamMember.user_id).where(TeamMember.team_id == team_id)).all()
    )


def _serialise(expense: Expense) -> ExpenseOut:
    return ExpenseOut(
        id=expense.id,
        team_id=expense.team_id,
        title=expense.title,
        note=expense.note,
        currency=expense.currency,
        total=expense.total,
        spent_at=expense.spent_at,
        payer_id=expense.payer_id,
        category_id=expense.category_id,
        split_mode=expense.split_mode,
        source=expense.source,
        receipt_id=expense.receipt_id,
        created_at=expense.created_at,
        shares=[
            ShareOut(user_id=s.user_id, amount=s.amount, weight=s.weight) for s in expense.shares
        ],
        items=[
            ExpenseItemOut(
                id=item.id,
                name=item.name,
                quantity=item.quantity,
                unit_price=item.unit_price,
                total=item.total,
                category_id=item.category_id,
                shares=[
                    ShareOut(user_id=s.user_id, amount=s.amount, weight=s.weight)
                    for s in item.shares
                ],
            )
            for item in expense.items
        ],
    )


def _apply(
    session: DbSession,
    expense: Expense,
    payload: ExpenseCreate | ExpenseUpdate,
    member_ids: set[uuid.UUID],
    team_id: uuid.UUID,
) -> None:
    """Validate a payload against team membership and write it onto ``expense``."""
    if payload.payer_id not in member_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "the payer is not in this team")

    referenced = {payload.category_id} | {i.category_id for i in payload.items}
    referenced.discard(None)
    if referenced:
        valid = set(
            session.scalars(
                select(Category.id).where(Category.team_id == team_id, Category.id.in_(referenced))
            ).all()
        )
        if unknown := referenced - valid:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"unknown category: {next(iter(unknown))}",
            )

    expense.title = payload.title.strip()
    expense.note = payload.note
    expense.spent_at = payload.spent_at
    expense.payer_id = payload.payer_id
    expense.category_id = payload.category_id

    try:
        if payload.split_mode is SplitMode.total:
            _reject_outsiders({s.user_id for s in payload.shares}, member_ids)
            assert payload.total is not None  # guaranteed by the schema validator
            expense.total = payload.total
            expense.items = []
            apply_total_split(expense, {s.user_id: Decimal(s.weight) for s in payload.shares})
        else:
            expense.items = [
                ExpenseItem(
                    position=index,
                    name=item.name.strip(),
                    quantity=item.quantity,
                    unit_price=item.unit_price,
                    total=item.total,
                    category_id=item.category_id,
                    shares=build_item_shares(
                        {
                            s.user_id: Decimal(s.weight)
                            for s in item.shares
                            if _check(s.user_id, member_ids)
                        }
                    ),
                )
                for index, item in enumerate(payload.items)
            ]
            apply_item_splits(expense)
    except SplitError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


def _check(user_id: uuid.UUID, member_ids: set[uuid.UUID]) -> bool:
    _reject_outsiders({user_id}, member_ids)
    return True


def _reject_outsiders(user_ids: set[uuid.UUID], member_ids: set[uuid.UUID]) -> None:
    if outsiders := user_ids - member_ids:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{next(iter(outsiders))} is not in this team",
        )


@router.get("", response_model=ExpenseListOut)
def list_expenses(
    membership: Membership,
    session: DbSession,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    category_id: uuid.UUID | None = None,
    payer_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=120),
) -> ExpenseListOut:
    filters = [Expense.team_id == membership.team_id]
    if category_id is not None:
        filters.append(Expense.category_id == category_id)
    if payer_id is not None:
        filters.append(Expense.payer_id == payer_id)
    if q:
        pattern = f"%{q.strip()}%"
        filters.append(or_(Expense.title.ilike(pattern), Expense.note.ilike(pattern)))

    total_count = session.scalar(select(func.count(Expense.id)).where(*filters)) or 0
    expenses = session.scalars(
        select(Expense)
        .where(*filters)
        .options(selectinload(Expense.shares), selectinload(Expense.items))
        .order_by(Expense.spent_at.desc(), Expense.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return ExpenseListOut(items=[_serialise(e) for e in expenses], total_count=total_count)


@router.post("", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
def create_expense(
    payload: ExpenseCreate,
    membership: Membership,
    team: TeamDep,
    user: CurrentUser,
    session: DbSession,
) -> ExpenseOut:
    if payload.receipt_id is not None:
        receipt = session.get(Receipt, payload.receipt_id)
        if receipt is None or receipt.team_id != team.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "receipt not found")

    expense = Expense(
        team_id=team.id,
        created_by_id=user.id,
        currency=team.currency,
        total=0,
        receipt_id=payload.receipt_id,
        source=ExpenseSource.receipt if payload.receipt_id else ExpenseSource.manual,
    )
    _apply(session, expense, payload, _member_ids(session, team.id), team.id)
    session.add(expense)
    session.commit()
    return _serialise(expense)


def _get(session: DbSession, team_id: uuid.UUID, expense_id: uuid.UUID) -> Expense:
    expense = session.get(Expense, expense_id)
    if expense is None or expense.team_id != team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "expense not found")
    return expense


@router.get("/{expense_id}", response_model=ExpenseOut)
def get_expense(expense_id: uuid.UUID, membership: Membership, session: DbSession) -> ExpenseOut:
    return _serialise(_get(session, membership.team_id, expense_id))


@router.put("/{expense_id}", response_model=ExpenseOut)
def update_expense(
    expense_id: uuid.UUID,
    payload: ExpenseUpdate,
    membership: Membership,
    team: TeamDep,
    session: DbSession,
) -> ExpenseOut:
    expense = _get(session, team.id, expense_id)

    # Drop the old rows and flush the DELETEs before the new ones are inserted.
    # Without this the unit of work emits the INSERTs first and collides with
    # the (expense_id, user_id) unique constraint on a re-split.
    expense.shares.clear()
    expense.items.clear()
    session.flush()

    _apply(session, expense, payload, _member_ids(session, team.id), team.id)
    session.commit()
    return _serialise(expense)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expense(expense_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    session.delete(_get(session, membership.team_id, expense_id))
    session.commit()
