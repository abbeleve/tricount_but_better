"""Telling team members what the others did.

A notification row is written in the same transaction as the change it is
about, so the in-app list can never miss one. Push delivery runs after the
response on its own session and is best-effort: a phone that is offline or a
push service that is down costs a buzz, never an expense.
"""

from __future__ import annotations

import logging
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from .config import get_settings
from .db import SessionLocal
from .models import (
    Expense,
    Notification,
    NotificationKind,
    PushSubscription,
    TeamMember,
    User,
)
from .money import exponent_for
from .webpush import PushOutcome, PushTarget, get_push_sender

log = logging.getLogger(__name__)

LANGUAGES = ("en", "ru")


def notify_expense_created(session: Session, expense: Expense, actor: User) -> list[Notification]:
    """Queue news of a new expense for everyone in the team except whoever added it."""
    session.flush()  # assigns the expense its id
    shares = {share.user_id: share.amount for share in expense.shares}
    recipients = session.scalars(
        select(TeamMember.user_id).where(
            TeamMember.team_id == expense.team_id, TeamMember.user_id != actor.id
        )
    ).all()
    notifications = [
        Notification(
            user_id=user_id,
            team_id=expense.team_id,
            actor_id=actor.id,
            expense_id=expense.id,
            kind=NotificationKind.expense_created,
            data={
                "title": expense.title,
                "total": expense.total,
                "currency": expense.currency,
                "share": shares.get(user_id, 0),
            },
        )
        for user_id in recipients
    ]
    session.add_all(notifications)
    return notifications


def unread_count(session: Session, user_id: uuid.UUID) -> int:
    """Unread news from the teams this person is still in."""
    return (
        session.scalar(
            select(func.count(Notification.id))
            .join(
                TeamMember,
                (TeamMember.team_id == Notification.team_id)
                & (TeamMember.user_id == Notification.user_id),
            )
            .where(Notification.user_id == user_id, Notification.read_at.is_(None))
        )
        or 0
    )


# ------------------------------------------------------------------- push text

# The symbols ``Intl.NumberFormat`` uses by default in each locale; every other
# currency is written as its code, exactly as the app shows it.
_SYMBOLS = {
    "en": {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"},
    "ru": {"RUB": "₽", "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"},
}

_TEXT = {
    "en": {
        "added": "{actor} added “{title}”",
        "share": "your share {amount}",
        "someone": "Someone",
    },
    "ru": {
        "added": "{actor}: новый расход «{title}»",
        "share": "ваша доля {amount}",
        "someone": "Кто-то",
    },
}


def format_money(minor: int, currency: str, language: str) -> str:
    """The app's ``formatMoney`` output (en-US / ru-RU), without a locale database."""
    code = currency.upper()
    exponent = exponent_for(code)
    value = abs(Decimal(minor)) / (Decimal(10) ** exponent)
    sign = "-" if minor < 0 else ""
    number = f"{value:,.{exponent}f}"
    if language == "ru":
        # Grouped with no-break spaces, a decimal comma, the symbol after.
        number = number.replace(",", "\u00a0").replace(".", ",")
        return f"{sign}{number}\u00a0{_SYMBOLS['ru'].get(code, code)}"
    symbol = _SYMBOLS["en"].get(code)
    return f"{sign}{symbol}{number}" if symbol else f"{sign}{code}\u00a0{number}"


def push_message(notification: Notification, language: str, unread: int) -> dict[str, Any]:
    """What the service worker shows: a title, a line of text and where a tap goes."""
    text = _TEXT.get(language, _TEXT["en"])
    data = notification.data
    actor = notification.actor.display_name if notification.actor else text["someone"]
    body = text["added"].format(actor=actor, title=data["title"])
    body += f" · {format_money(data['total'], data['currency'], language)}"
    if data.get("share"):
        share = format_money(data["share"], data["currency"], language)
        body += " · " + text["share"].format(amount=share)
    return {
        "id": str(notification.id),
        "title": notification.team.name,
        "body": body,
        # ``n`` lets the app mark this one read when the tap opens it.
        "url": (
            f"/teams/{notification.team_id}/expenses/{notification.expense_id}?n={notification.id}"
        ),
        "unread": unread,
    }


# -------------------------------------------------------------------- delivery


def deliver_push(notification_ids: list[uuid.UUID]) -> None:
    """Send each notification to every device its recipient turned push on for.

    Runs as a background task, after the response has gone out.
    """
    if not notification_ids:
        return
    with SessionLocal() as session:
        notifications = session.scalars(
            select(Notification)
            .where(Notification.id.in_(notification_ids))
            .options(selectinload(Notification.team), selectinload(Notification.actor))
        ).all()
        recipients = {n.user_id for n in notifications}
        subscriptions = session.scalars(
            select(PushSubscription).where(PushSubscription.user_id.in_(recipients))
        ).all()
        if not subscriptions:
            return

        sender = get_push_sender(get_settings())
        gone: set[uuid.UUID] = set()
        for notification in notifications:
            unread = unread_count(session, notification.user_id)
            for subscription in subscriptions:
                if subscription.user_id != notification.user_id or subscription.id in gone:
                    continue
                target = PushTarget(subscription.endpoint, subscription.p256dh, subscription.auth)
                message = push_message(notification, subscription.language, unread)
                try:
                    outcome = sender.send(target, message)
                except Exception:  # a broken sender must not take the others down
                    log.exception("push delivery crashed")
                    outcome = PushOutcome.failed
                if outcome is PushOutcome.gone:
                    gone.add(subscription.id)

        if gone:
            session.execute(delete(PushSubscription).where(PushSubscription.id.in_(gone)))
            session.commit()
