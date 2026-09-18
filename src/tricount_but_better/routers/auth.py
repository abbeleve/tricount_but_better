"""Registration, login, token refresh."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import User
from ..schemas import LoginIn, RefreshIn, RegisterIn, TokenOut, UserOut
from ..security import (
    TokenError,
    create_token,
    decode_token,
    hash_password,
    needs_rehash,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

_BAD_CREDENTIALS = HTTPException(
    status.HTTP_401_UNAUTHORIZED,
    "email or password is incorrect",
    headers={"WWW-Authenticate": "Bearer"},
)


def _tokens(user: User) -> TokenOut:
    return TokenOut(
        access_token=create_token(user.id, "access"),
        refresh_token=create_token(user.id, "refresh"),
    )


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterIn, session: DbSession) -> TokenOut:
    email = payload.email.lower()
    if session.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "that email is already registered")

    user = User(
        email=email,
        display_name=payload.display_name.strip(),
        password_hash=hash_password(payload.password),
    )
    session.add(user)
    session.commit()
    return _tokens(user)


@router.post("/login", response_model=TokenOut)
def login(payload: LoginIn, session: DbSession) -> TokenOut:
    user = session.scalar(select(User).where(User.email == payload.email.lower()))
    if user is None or not user.is_active:
        # Still hash something so a missing account is not detectably faster.
        hash_password(payload.password)
        raise _BAD_CREDENTIALS
    if not verify_password(payload.password, user.password_hash):
        raise _BAD_CREDENTIALS

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)
        session.commit()
    return _tokens(user)


@router.post("/refresh", response_model=TokenOut)
def refresh(payload: RefreshIn, session: DbSession) -> TokenOut:
    try:
        user_id = decode_token(payload.refresh_token, expect="refresh")
    except TokenError as exc:
        raise _BAD_CREDENTIALS from exc
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise _BAD_CREDENTIALS
    return _tokens(user)


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user
