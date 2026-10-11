"""Application settings, loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- core ---
    app_name: str = "Tricount but better"
    environment: Literal["dev", "test", "prod"] = "dev"
    # A single file. Point at Postgres instead by
    # setting DATABASE_URL and installing the "postgres" extra.
    database_url: str = "sqlite:///var/tricount.db"

    # --- auth ---
    jwt_secret: str = "dev-only-insecure-secret-change-me"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 30
    refresh_token_ttl_days: int = 30

    # --- http ---
    # NoDecode: without it pydantic-settings tries to JSON-parse the env value
    # before the validator below gets to split a plain comma-separated list.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )
    default_currency: str = "RUB"

    # --- photo limits ---
    max_upload_mb: int = 12
    max_receipt_images: int = 8

    # --- VLM ---
    # Polza OpenAI-compatible API. A separate key file supports deployments
    # whose root-owned EnvironmentFile still contains the old disabled flag.
    vlm_model: str = "qwen/qwen3.5-9b"
    vlm_timeout_seconds: int = 180
    # How many of the team's most recently bought goods the model is shown to
    # match receipt lines against. Each costs a dozen or so prompt tokens.
    vlm_known_products: int = 200
    polza_api_key: str | None = None
    polza_api_key_file: Path = Path(".secrets/polza_api_key")

    # --- web push ---
    # The VAPID key that signs push requests. Unset, it is derived from
    # JWT_SECRET, so a deployment gets working push without a new secret; set it
    # (a base64url P-256 private scalar) only to rotate it independently.
    vapid_private_key: str | None = None
    # Who push services contact about abuse. Unset, the first https CORS origin.
    vapid_subject: str | None = None
    push_timeout_seconds: float = 10.0

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def effective_polza_api_key(self) -> str | None:
        if self.polza_api_key:
            return self.polza_api_key
        try:
            return self.polza_api_key_file.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None

    @property
    def effective_vapid_subject(self) -> str:
        if self.vapid_subject:
            return self.vapid_subject
        origin = next((o for o in self.cors_origins if o.startswith("https://")), None)
        return origin or "mailto:push@tricount.invalid"


@lru_cache
def get_settings() -> Settings:
    return Settings()
