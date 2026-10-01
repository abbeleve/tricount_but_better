"""Compact spending history, independent of expense-list pagination."""

from fastapi import APIRouter
from sqlalchemy import func, select

from ..deps import DbSession, TeamDep
from ..models import Expense
from ..schemas import DailySpendingOut, SpendingOut

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
