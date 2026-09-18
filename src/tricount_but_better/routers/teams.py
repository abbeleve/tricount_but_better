"""Teams, members, balances and settlements."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from ..balances import simplify_debts, team_net
from ..deps import CurrentUser, DbSession, Membership, OwnerMembership, TeamDep
from ..models import (
    Category,
    Expense,
    ExpenseShare,
    Settlement,
    Team,
    TeamMember,
    TeamRole,
    User,
)
from ..schemas import (
    BalanceOut,
    BalancesOut,
    CategoryTotalOut,
    MemberOut,
    MemberUpdate,
    SettlementCreate,
    SettlementOut,
    TeamCreate,
    TeamDetailOut,
    TeamOut,
    TeamUpdate,
    TransferOut,
)

router = APIRouter(prefix="/teams", tags=["teams"])

# Seeded on team creation so the category picker is never an empty state.
DEFAULT_CATEGORIES = [
    ("Groceries", "\U0001f6d2"),
    ("Eating out", "\U0001f37d"),
    ("Household", "\U0001f9fd"),
    ("Transport", "\U0001f68c"),
    ("Utilities", "\U0001f4a1"),
    ("Fun", "\U0001f3ae"),
]


def _members_out(session: DbSession, team_id: uuid.UUID) -> list[MemberOut]:
    rows = session.execute(
        select(TeamMember, User)
        .join(User, User.id == TeamMember.user_id)
        .where(TeamMember.team_id == team_id)
        .order_by(User.display_name)
    ).all()
    return [
        MemberOut(
            user_id=user.id,
            display_name=user.display_name,
            email=user.email,
            role=member.role,
            default_weight=member.default_weight,
        )
        for member, user in rows
    ]


@router.post("", response_model=TeamDetailOut, status_code=status.HTTP_201_CREATED)
def create_team(payload: TeamCreate, user: CurrentUser, session: DbSession) -> TeamDetailOut:
    team = Team(name=payload.name.strip(), currency=payload.currency.upper())
    session.add(team)
    session.flush()

    session.add(TeamMember(team_id=team.id, user_id=user.id, role=TeamRole.owner))
    session.add_all(
        Category(team_id=team.id, name=name, emoji=emoji) for name, emoji in DEFAULT_CATEGORIES
    )
    session.commit()

    return TeamDetailOut(
        id=team.id,
        name=team.name,
        currency=team.currency,
        created_at=team.created_at,
        members=_members_out(session, team.id),
        my_role=TeamRole.owner,
    )


@router.get("", response_model=list[TeamOut])
def list_teams(user: CurrentUser, session: DbSession) -> list[TeamOut]:
    """Every team the caller belongs to, each with their own net position.

    The three aggregates below are per-team sums scoped to this user, so the
    response costs a fixed number of queries no matter how many teams there are.
    """
    teams = session.scalars(
        select(Team)
        .join(TeamMember, TeamMember.team_id == Team.id)
        .where(TeamMember.user_id == user.id)
        .order_by(Team.created_at.desc())
    ).all()
    if not teams:
        return []

    team_ids = [t.id for t in teams]

    counts = dict(
        session.execute(
            select(TeamMember.team_id, func.count(TeamMember.id))
            .where(TeamMember.team_id.in_(team_ids))
            .group_by(TeamMember.team_id)
        ).all()
    )
    paid = dict(
        session.execute(
            select(Expense.team_id, func.sum(Expense.total))
            .where(Expense.team_id.in_(team_ids), Expense.payer_id == user.id)
            .group_by(Expense.team_id)
        ).all()
    )
    owed = dict(
        session.execute(
            select(Expense.team_id, func.sum(ExpenseShare.amount))
            .join(Expense, Expense.id == ExpenseShare.expense_id)
            .where(Expense.team_id.in_(team_ids), ExpenseShare.user_id == user.id)
            .group_by(Expense.team_id)
        ).all()
    )
    sent = dict(
        session.execute(
            select(Settlement.team_id, func.sum(Settlement.amount))
            .where(Settlement.team_id.in_(team_ids), Settlement.from_user_id == user.id)
            .group_by(Settlement.team_id)
        ).all()
    )
    received = dict(
        session.execute(
            select(Settlement.team_id, func.sum(Settlement.amount))
            .where(Settlement.team_id.in_(team_ids), Settlement.to_user_id == user.id)
            .group_by(Settlement.team_id)
        ).all()
    )

    return [
        TeamOut(
            id=team.id,
            name=team.name,
            currency=team.currency,
            created_at=team.created_at,
            member_count=counts.get(team.id, 0),
            my_balance=(
                (paid.get(team.id) or 0)
                - (owed.get(team.id) or 0)
                + (sent.get(team.id) or 0)
                - (received.get(team.id) or 0)
            ),
        )
        for team in teams
    ]


@router.get("/{team_id}", response_model=TeamDetailOut)
def get_team_detail(membership: Membership, team: TeamDep, session: DbSession) -> TeamDetailOut:
    return TeamDetailOut(
        id=team.id,
        name=team.name,
        currency=team.currency,
        created_at=team.created_at,
        members=_members_out(session, team.id),
        my_role=membership.role,
    )


@router.patch("/{team_id}", response_model=TeamDetailOut)
def update_team(
    payload: TeamUpdate,
    membership: OwnerMembership,
    team: TeamDep,
    session: DbSession,
) -> TeamDetailOut:
    if payload.name is not None:
        team.name = payload.name.strip()
    session.commit()
    return TeamDetailOut(
        id=team.id,
        name=team.name,
        currency=team.currency,
        created_at=team.created_at,
        members=_members_out(session, team.id),
        my_role=membership.role,
    )


@router.delete("/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team(membership: OwnerMembership, team: TeamDep, session: DbSession) -> None:
    session.delete(team)
    session.commit()


@router.patch("/{team_id}/members/{member_user_id}", response_model=MemberOut)
def update_member(
    member_user_id: uuid.UUID,
    payload: MemberUpdate,
    membership: OwnerMembership,
    session: DbSession,
) -> MemberOut:
    target = session.scalar(
        select(TeamMember).where(
            TeamMember.team_id == membership.team_id,
            TeamMember.user_id == member_user_id,
        )
    )
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that person is not in this team")

    if payload.role is not None and target.role != payload.role:
        if target.role == TeamRole.owner and _owner_count(session, membership.team_id) == 1:
            raise HTTPException(status.HTTP_409_CONFLICT, "a team needs at least one owner")
        target.role = payload.role
    if payload.default_weight is not None:
        target.default_weight = payload.default_weight

    session.commit()
    user = session.get(User, member_user_id)
    assert user is not None
    return MemberOut(
        user_id=user.id,
        display_name=user.display_name,
        email=user.email,
        role=target.role,
        default_weight=target.default_weight,
    )


def _owner_count(session: DbSession, team_id: uuid.UUID) -> int:
    return (
        session.scalar(
            select(func.count(TeamMember.id)).where(
                TeamMember.team_id == team_id, TeamMember.role == TeamRole.owner
            )
        )
        or 0
    )


@router.delete("/{team_id}/members/{member_user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    member_user_id: uuid.UUID,
    membership: Membership,
    user: CurrentUser,
    session: DbSession,
) -> None:
    """Remove someone, or leave yourself.

    Refuses while the person still has a non-zero balance -- deleting them would
    silently redistribute their debt to everyone else.
    """
    leaving_self = member_user_id == user.id
    if not leaving_self and membership.role != TeamRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only a team owner can do that")

    target = session.scalar(
        select(TeamMember).where(
            TeamMember.team_id == membership.team_id,
            TeamMember.user_id == member_user_id,
        )
    )
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that person is not in this team")

    net = team_net(session, membership.team_id)
    if net.get(member_user_id, 0) != 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "settle up with this person before removing them from the team",
        )
    if target.role == TeamRole.owner and _owner_count(session, membership.team_id) == 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "a team needs at least one owner")

    session.delete(target)
    session.commit()


@router.get("/{team_id}/balances", response_model=BalancesOut)
def get_balances(membership: Membership, team: TeamDep, session: DbSession) -> BalancesOut:
    net = team_net(session, team.id)
    members = _members_out(session, team.id)
    names = {m.user_id: m.display_name for m in members}

    total_spend = (
        session.scalar(select(func.sum(Expense.total)).where(Expense.team_id == team.id)) or 0
    )

    return BalancesOut(
        currency=team.currency,
        balances=[
            BalanceOut(
                user_id=m.user_id,
                display_name=m.display_name,
                net=net.get(m.user_id, 0),
            )
            for m in members
        ],
        transfers=[
            TransferOut(
                from_user_id=t.from_user,
                to_user_id=t.to_user,
                amount=t.amount,
            )
            for t in simplify_debts({u: n for u, n in net.items() if u in names})
        ],
        total_spend=total_spend,
    )


@router.get("/{team_id}/category-totals", response_model=list[CategoryTotalOut])
def category_totals(
    membership: Membership, team: TeamDep, session: DbSession
) -> list[CategoryTotalOut]:
    rows = session.execute(
        select(Expense.category_id, func.sum(Expense.total))
        .where(Expense.team_id == team.id)
        .group_by(Expense.category_id)
    ).all()
    categories = {
        c.id: c for c in session.scalars(select(Category).where(Category.team_id == team.id)).all()
    }
    out = []
    for category_id, total in rows:
        category = categories.get(category_id) if category_id else None
        out.append(
            CategoryTotalOut(
                category_id=category_id,
                name=category.name if category else "Uncategorised",
                emoji=category.emoji if category else "",
                total=total or 0,
            )
        )
    return sorted(out, key=lambda c: -c.total)


@router.get("/{team_id}/settlements", response_model=list[SettlementOut])
def list_settlements(membership: Membership, team: TeamDep, session: DbSession) -> list[Settlement]:
    return list(
        session.scalars(
            select(Settlement)
            .where(Settlement.team_id == team.id)
            .order_by(Settlement.settled_at.desc(), Settlement.created_at.desc())
        ).all()
    )


@router.post(
    "/{team_id}/settlements",
    response_model=SettlementOut,
    status_code=status.HTTP_201_CREATED,
)
def create_settlement(
    payload: SettlementCreate,
    membership: Membership,
    team: TeamDep,
    user: CurrentUser,
    session: DbSession,
) -> Settlement:
    member_ids = {
        m
        for m in session.scalars(
            select(TeamMember.user_id).where(TeamMember.team_id == team.id)
        ).all()
    }
    for person in (payload.from_user_id, payload.to_user_id):
        if person not in member_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "that person is not in this team"
            )

    settlement = Settlement(
        team_id=team.id,
        from_user_id=payload.from_user_id,
        to_user_id=payload.to_user_id,
        created_by_id=user.id,
        amount=payload.amount,
        currency=team.currency,
        note=payload.note,
        settled_at=payload.settled_at,
    )
    session.add(settlement)
    session.commit()
    return settlement


@router.delete("/{team_id}/settlements/{settlement_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_settlement(settlement_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    settlement = session.get(Settlement, settlement_id)
    if settlement is None or settlement.team_id != membership.team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "settlement not found")
    session.delete(settlement)
    session.commit()
