"""Shopping plans that become ledger expenses only after a purchase."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession, Membership, TeamDep
from ..models import Category, Expense, ExpenseSource, PlannedExpense, Receipt
from ..schemas import ExpenseCreate, ExpenseOut, PlannedExpenseIn, PlannedExpenseOut
from .expenses import _apply, _member_ids, _serialise

router = APIRouter(prefix="/teams/{team_id}/plans", tags=["planned expenses"])


def _get(session: DbSession, team_id: uuid.UUID, plan_id: uuid.UUID) -> PlannedExpense:
    plan = session.get(PlannedExpense, plan_id)
    if plan is None or plan.team_id != team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plan not found")
    return plan


def _serialise_plan(plan: PlannedExpense) -> PlannedExpenseOut:
    return PlannedExpenseOut(
        id=plan.id,
        team_id=plan.team_id,
        title=plan.title,
        note=plan.note,
        category_id=plan.category_id,
        items=plan.items,
        created_at=plan.created_at,
    )


def _apply_plan(session: DbSession, plan: PlannedExpense, payload: PlannedExpenseIn) -> None:
    if not payload.title.strip() or any(not item.name.strip() for item in payload.items):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "names cannot be blank")
    if payload.category_id is not None:
        category = session.get(Category, payload.category_id)
        if category is None or category.team_id != plan.team_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "unknown category")
    plan.title = payload.title.strip()
    plan.note = payload.note
    plan.category_id = payload.category_id
    plan.items = [{"name": item.name.strip(), "total": item.total} for item in payload.items]


@router.get("", response_model=list[PlannedExpenseOut])
def list_plans(membership: Membership, session: DbSession) -> list[PlannedExpenseOut]:
    plans = session.scalars(
        select(PlannedExpense)
        .where(PlannedExpense.team_id == membership.team_id)
        .order_by(PlannedExpense.updated_at.desc(), PlannedExpense.created_at.desc())
    ).all()
    return [_serialise_plan(plan) for plan in plans]


@router.post("", response_model=PlannedExpenseOut, status_code=status.HTTP_201_CREATED)
def create_plan(
    payload: PlannedExpenseIn,
    team: TeamDep,
    user: CurrentUser,
    session: DbSession,
) -> PlannedExpenseOut:
    plan = PlannedExpense(team_id=team.id, created_by_id=user.id, items=[])
    _apply_plan(session, plan, payload)
    session.add(plan)
    session.commit()
    return _serialise_plan(plan)


@router.get("/{plan_id}", response_model=PlannedExpenseOut)
def get_plan(plan_id: uuid.UUID, membership: Membership, session: DbSession) -> PlannedExpenseOut:
    return _serialise_plan(_get(session, membership.team_id, plan_id))


@router.put("/{plan_id}", response_model=PlannedExpenseOut)
def update_plan(
    plan_id: uuid.UUID,
    payload: PlannedExpenseIn,
    membership: Membership,
    session: DbSession,
) -> PlannedExpenseOut:
    plan = _get(session, membership.team_id, plan_id)
    _apply_plan(session, plan, payload)
    session.commit()
    return _serialise_plan(plan)


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan(plan_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    session.delete(_get(session, membership.team_id, plan_id))
    session.commit()


@router.post("/{plan_id}/complete", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
def complete_plan(
    plan_id: uuid.UUID,
    payload: ExpenseCreate,
    team: TeamDep,
    user: CurrentUser,
    session: DbSession,
) -> ExpenseOut:
    """Create the real expense and remove the plan in one transaction."""
    plan = _get(session, team.id, plan_id)
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
    session.delete(plan)
    session.commit()
    return _serialise(expense)
