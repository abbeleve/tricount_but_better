"""Per-team expense categories."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..deps import DbSession, Membership
from ..models import Category
from ..schemas import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/teams/{team_id}/categories", tags=["categories"])


@router.get("", response_model=list[CategoryOut])
def list_categories(
    membership: Membership, session: DbSession, include_archived: bool = False
) -> list[Category]:
    query = select(Category).where(Category.team_id == membership.team_id)
    if not include_archived:
        query = query.where(Category.is_archived.is_(False))
    return list(session.scalars(query.order_by(Category.name)).all())


@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: CategoryCreate, membership: Membership, session: DbSession
) -> Category:
    category = Category(
        team_id=membership.team_id,
        name=payload.name.strip(),
        emoji=payload.emoji,
        color=payload.color,
    )
    session.add(category)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a category with that name already exists"
        ) from exc
    return category


def _get(session: DbSession, membership: Membership, category_id: uuid.UUID) -> Category:
    category = session.get(Category, category_id)
    if category is None or category.team_id != membership.team_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "category not found")
    return category


@router.patch("/{category_id}", response_model=CategoryOut)
def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    membership: Membership,
    session: DbSession,
) -> Category:
    category = _get(session, membership, category_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(category, field, value.strip() if field == "name" else value)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a category with that name already exists"
        ) from exc
    return category


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_category(category_id: uuid.UUID, membership: Membership, session: DbSession) -> None:
    """Archive rather than delete: expenses keep pointing at a real category."""
    category = _get(session, membership, category_id)
    category.is_archived = True
    session.commit()
