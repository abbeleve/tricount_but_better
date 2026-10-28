"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import (
    auth,
    categories,
    expenses,
    invites,
    notifications,
    planned_expenses,
    price_scans,
    products,
    receipts,
    scans,
    shops,
    spending,
    teams,
)
from .scan_jobs import jobs as scan_jobs
from .webpush import vapid_key

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    # Scans still being read die with the process; let them go quietly.
    await scan_jobs.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Shared expenses, split per item, with AI receipt reading.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    for router in (
        auth.router,
        teams.router,
        invites.router,
        categories.router,
        expenses.router,
        spending.router,
        planned_expenses.router,
        receipts.router,
        shops.router,
        products.router,
        price_scans.router,
        scans.router,
        notifications.router,
    ):
        app.include_router(router, prefix="/api")

    @app.get("/api/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/config", tags=["meta"])
    def client_config() -> dict[str, object]:
        """Feature flags the frontend needs before it can render."""
        return {
            "receipt_scanning": bool(settings.effective_polza_api_key),
            "default_currency": settings.default_currency,
            "max_receipt_images": settings.max_receipt_images,
            "max_upload_mb": settings.max_upload_mb,
            # The applicationServerKey a browser subscribes to push with.
            "push_public_key": vapid_key(settings).public_key,
        }

    return app


app = create_app()
