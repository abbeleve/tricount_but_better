"""Invite links: create, revoke, preview, accept."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from ..deps import CurrentUser, DbSession, Membership, OwnerMembership
from ..models import Invite, Team, TeamMember, TeamRole
from ..schemas import InviteCreate, InviteOut, InvitePreviewOut, TeamDetailOut
from .teams import _members_out

router = APIRouter(tags=["invites"])


def _as_utc(moment: datetime | None) -> datetime | None:
    """Treat a stored datetime as UTC.

    Backends differ on whether they hand back tzinfo -- Postgres does for
    ``timestamptz``, SQLite does not -- and comparing the two kinds raises.
    Everything written here is UTC, so attaching it back is safe.
    """
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _is_usable(invite: Invite) -> bool:
    if invite.revoked_at is not None:
        return False
    expires_at = _as_utc(invite.expires_at)
    if expires_at is not None and expires_at < datetime.now(UTC):
        return False
    if invite.max_uses is not None and invite.use_count >= invite.max_uses:
        return False
    return True


def _out(invite: Invite) -> InviteOut:
    return InviteOut(
        id=invite.id,
        code=invite.code,
        team_id=invite.team_id,
        expires_at=invite.expires_at,
        max_uses=invite.max_uses,
        use_count=invite.use_count,
        revoked=not _is_usable(invite),
    )


@router.post(
    "/teams/{team_id}/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED
)
def create_invite(
    payload: InviteCreate,
    membership: OwnerMembership,
    user: CurrentUser,
    session: DbSession,
) -> InviteOut:
    expires_at = (
        datetime.now(UTC) + timedelta(days=payload.expires_in_days)
        if payload.expires_in_days
        else None
    )
    invite = Invite(
        team_id=membership.team_id,
        code=secrets.token_urlsafe(12),
        created_by_id=user.id,
        expires_at=expires_at,
        max_uses=payload.max_uses,
    )
    session.add(invite)
    session.commit()
    return _out(invite)


@router.get("/teams/{team_id}/invites", response_model=list[InviteOut])
def list_invites(membership: Membership, session: DbSession) -> list[InviteOut]:
    invites = session.scalars(
        select(Invite)
        .where(Invite.team_id == membership.team_id)
        .order_by(Invite.created_at.desc())
    ).all()
    return [_out(i) for i in invites]


@router.delete("/teams/{team_id}/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invite(invite_id: uuid.UUID, membership: OwnerMembership, session: DbSession) -> None:
    invite = session.get(Invite, invite_id)
    if invite is None or invite.team_id != membership.team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invite not found")
    invite.revoked_at = datetime.now(UTC)
    session.commit()


def _lookup(session: DbSession, code: str) -> Invite:
    invite = session.scalar(select(Invite).where(Invite.code == code))
    if invite is None or not _is_usable(invite):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this invite link is no longer valid")
    return invite


@router.get("/invites/{code}", response_model=InvitePreviewOut)
def preview_invite(code: str, user: CurrentUser, session: DbSession) -> InvitePreviewOut:
    """What the recipient sees before joining. Deliberately minimal."""
    invite = _lookup(session, code)
    team = session.get(Team, invite.team_id)
    assert team is not None
    count = session.scalar(select(func.count(TeamMember.id)).where(TeamMember.team_id == team.id))
    return InvitePreviewOut(team_name=team.name, member_count=count or 0, currency=team.currency)


@router.post("/invites/{code}/accept", response_model=TeamDetailOut)
def accept_invite(code: str, user: CurrentUser, session: DbSession) -> TeamDetailOut:
    invite = _lookup(session, code)
    team = session.get(Team, invite.team_id)
    assert team is not None

    existing = session.scalar(
        select(TeamMember).where(TeamMember.team_id == team.id, TeamMember.user_id == user.id)
    )
    if existing is None:
        session.add(TeamMember(team_id=team.id, user_id=user.id, role=TeamRole.member))
        invite.use_count += 1
        session.commit()
        role = TeamRole.member
    else:
        # Re-following your own invite link is a no-op, not an error.
        role = existing.role

    return TeamDetailOut(
        id=team.id,
        name=team.name,
        currency=team.currency,
        created_at=team.created_at,
        members=_members_out(session, team.id),
        my_role=role,
    )
