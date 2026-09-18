"""FastAPI application factory."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers import auth, categories, expenses, invites, receipts, teams

logging.basicConfig(level=logging.INFO)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Shared expenses, split per item, with AI receipt reading.",
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
        receipts.router,
    ):
        app.include_router(router, prefix="/api")

    @app.get("/api/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/config", tags=["meta"])
    def client_config() -> dict[str, object]:
        """Feature flags the frontend needs before it can render."""
        return {
            "receipt_scanning": settings.vlm_provider != "disabled",
            "default_currency": settings.default_currency,
            "max_receipt_images": settings.max_receipt_images,
            "max_upload_mb": settings.max_upload_mb,
        }

    return app


app = create_app()
