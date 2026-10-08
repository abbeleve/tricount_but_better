"""The signed-in user's notifications, and the devices that receive them as push."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, select, update
from sqlalchemy.orm import selectinload

from ..deps import CurrentUser, DbSession
from ..models import Notification, PushSubscription, TeamMember
from ..notifications import unread_count
from ..schemas import (
    NotificationListOut,
    NotificationOut,
    NotificationsRead,
    PushSubscriptionIn,
    PushSubscriptionRemove,
    UnreadOut,
)
from ..webpush import PushKeyError, check_subscription

router = APIRouter(tags=["notifications"])


def _serialise(notification: Notification) -> NotificationOut:
    data = notification.data
    created_at = notification.created_at
    # SQLite hands back naive datetimes; without a zone the client would read
    # them as local time and an hour-old expense would look three hours old.
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return NotificationOut(
        id=notification.id,
        kind=notification.kind,
        created_at=created_at,
        read=notification.read_at is not None,
        team_id=notification.team_id,
        team_name=notification.team.name,
        actor_id=notification.actor_id,
        actor_name=notification.actor.display_name if notification.actor else None,
        expense_id=notification.expense_id,
        title=data["title"],
        total=data["total"],
        currency=data["currency"],
        share=data.get("share", 0),
    )


@router.get("/notifications", response_model=NotificationListOut)
def list_notifications(
    user: CurrentUser,
    session: DbSession,
    limit: int = Query(default=50, ge=1, le=200),
) -> NotificationListOut:
    """Newest first. News from a team you have since left is not shown."""
    notifications = session.scalars(
        select(Notification)
        .join(
            TeamMember,
            (TeamMember.team_id == Notification.team_id)
            & (TeamMember.user_id == Notification.user_id),
        )
        .where(Notification.user_id == user.id)
        .options(selectinload(Notification.team), selectinload(Notification.actor))
        .order_by(Notification.created_at.desc(), Notification.id)
        .limit(limit)
    ).all()
    return NotificationListOut(
        items=[_serialise(n) for n in notifications],
        unread_count=unread_count(session, user.id),
    )


@router.post("/notifications/read", response_model=UnreadOut)
def mark_read(payload: NotificationsRead, user: CurrentUser, session: DbSession) -> UnreadOut:
    """Only ever touches the caller's own rows; ids that are not theirs are ignored."""
    statement = update(Notification).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)
    )
    if payload.ids is not None:
        statement = statement.where(Notification.id.in_(payload.ids))
    session.execute(statement.values(read_at=datetime.now(UTC)))
    session.commit()
    return UnreadOut(unread_count=unread_count(session, user.id))


@router.put("/push/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
def save_subscription(payload: PushSubscriptionIn, user: CurrentUser, session: DbSession) -> None:
    """Register this browser for push, or refresh its keys and language.

    An endpoint already registered to someone else moves to the caller: it is
    the same browser, now signed in as them.
    """
    try:
        check_subscription(payload.endpoint, payload.keys.p256dh, payload.keys.auth)
    except PushKeyError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc

    subscription = session.scalar(
        select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
    )
    if subscription is None:
        subscription = PushSubscription(endpoint=payload.endpoint)
        session.add(subscription)
    subscription.user_id = user.id
    subscription.p256dh = payload.keys.p256dh
    subscription.auth = payload.keys.auth
    subscription.language = payload.language
    session.commit()


@router.delete("/push/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
def remove_subscription(
    payload: PushSubscriptionRemove, user: CurrentUser, session: DbSession
) -> None:
    session.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == payload.endpoint, PushSubscription.user_id == user.id
        )
    )
    session.commit()
