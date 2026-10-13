"""Compact spending history, independent of expense-list pagination."""

import uuid
from collections import defaultdict
from datetime import date

from fastapi import APIRouter
from sqlalchemy import func, select

from ..deps import DbSession, TeamDep
from ..models import Expense, ExpenseShare, TeamMember, User
from ..schemas import DailySpendingOut, PeopleSpendingOut, PersonSpendingOut, SpendingOut

router = APIRouter(prefix="/teams/{team_id}/spending", tags=["spending"])


@router.get("", response_model=SpendingOut)
def spending(team: TeamDep, session: DbSession) -> SpendingOut:
    """Sum each expense once, without joins to its items or participant shares.

    Calendar boundaries belong to the client: spent_at is a purchase date,
    and "today" follows the viewer's local calendar, not the server's.
    Plans and settlements are separate tables and never enter these totals.
    """
    rows = session.execute(
        select(Expense.spent_at, func.sum(Expense.total), func.count(Expense.id))
        .where(Expense.team_id == team.id)
        .group_by(Expense.spent_at)
        .order_by(Expense.spent_at)
    ).all()
    return SpendingOut(
        currency=team.currency,
        days=[
            DailySpendingOut(date=spent_at, total=total, expense_count=count)
            for spent_at, total, count in rows
        ],
    )


def _by_person(
    rows: list[tuple[uuid.UUID, date, int, int]],
) -> dict[uuid.UUID, list[DailySpendingOut]]:
    days: dict[uuid.UUID, list[DailySpendingOut]] = defaultdict(list)
    for user_id, spent_at, total, count in rows:
        days[user_id].append(DailySpendingOut(date=spent_at, total=total, expense_count=count))
    return days


@router.get("/people", response_model=PeopleSpendingOut)
def people_spending(team: TeamDep, session: DbSession) -> PeopleSpendingOut:
    """The same daily history, per person: who paid, and whose share it was.

    Current members come first, in the order they joined, so a person keeps
    their place (and their chart colour) as others join. Anyone who has left
    but still has expenses on the books follows, so the parts always add up
    to the team's spending.
    """
    paid = _by_person(
        session.execute(
            select(
                Expense.payer_id, Expense.spent_at, func.sum(Expense.total), func.count(Expense.id)
            )
            .where(Expense.team_id == team.id)
            .group_by(Expense.payer_id, Expense.spent_at)
            .order_by(Expense.spent_at)
        ).all()
    )
    share = _by_person(
        session.execute(
            select(
                ExpenseShare.user_id,
                Expense.spent_at,
                func.sum(ExpenseShare.amount),
                func.count(ExpenseShare.id),
            )
            .join(Expense, Expense.id == ExpenseShare.expense_id)
            .where(Expense.team_id == team.id)
            .group_by(ExpenseShare.user_id, Expense.spent_at)
            .order_by(Expense.spent_at)
        ).all()
    )

    members = session.execute(
        select(User.id, User.display_name)
        .join(TeamMember, TeamMember.user_id == User.id)
        .where(TeamMember.team_id == team.id)
        .order_by(TeamMember.joined_at, User.display_name)
    ).all()
    member_ids = {user_id for user_id, _ in members}
    former_ids = (paid.keys() | share.keys()) - member_ids
    former = (
        session.execute(
            select(User.id, User.display_name)
            .where(User.id.in_(former_ids))
            .order_by(User.display_name)
        ).all()
        if former_ids
        else []
    )

    return PeopleSpendingOut(
        currency=team.currency,
        people=[
            PersonSpendingOut(
                user_id=user_id,
                display_name=name,
                is_member=user_id in member_ids,
                paid=paid.get(user_id, []),
                share=share.get(user_id, []),
            )
            for user_id, name in [*members, *former]
        ],
    )
