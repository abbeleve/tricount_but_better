"""Shared FastAPI dependencies: authentication and team authorisation."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Path, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import get_session
from .models import Team, TeamMember, TeamRole, User
from .security import TokenError, decode_token

_bearer = HTTPBearer(auto_error=False, description="JWT access token")

_UNAUTHORISED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[Session, Depends(get_session)],
) -> User:
    if credentials is None:
        raise _UNAUTHORISED
    try:
        user_id = decode_token(credentials.credentials, expect="access")
    except TokenError as exc:
        raise _UNAUTHORISED from exc

    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise _UNAUTHORISED
    return user


CurrentUser = Annotated[User, Depends(current_user)]
DbSession = Annotated[Session, Depends(get_session)]


def team_membership(
    team_id: Annotated[uuid.UUID, Path()],
    user: CurrentUser,
    session: DbSession,
) -> TeamMember:
    """Resolve the caller's membership, or 404.

    Non-members get 404 rather than 403 on purpose: whether a given team id
    exists is not something an outsider should be able to probe.
    """
    membership = session.scalar(
        select(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user.id)
    )
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "team not found")
    return membership


Membership = Annotated[TeamMember, Depends(team_membership)]


def owner_membership(membership: Membership) -> TeamMember:
    if membership.role != TeamRole.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only a team owner can do that")
    return membership


OwnerMembership = Annotated[TeamMember, Depends(owner_membership)]


def get_team(membership: Membership, session: DbSession) -> Team:
    team = session.get(Team, membership.team_id)
    if team is None:  # pragma: no cover - FK makes this unreachable
        raise HTTPException(status.HTTP_404_NOT_FOUND, "team not found")
    return team


TeamDep = Annotated[Team, Depends(get_team)]
