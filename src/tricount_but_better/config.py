"""Application settings, loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

VlmProvider = Literal["polza", "disabled"]


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
    # polza -> OpenAI-compatible Polza API, authenticates with POLZA_API_KEY
    vlm_provider: VlmProvider = "polza"
    vlm_model: str = "qwen/qwen3.5-9b"
    vlm_timeout_seconds: int = 180
    polza_api_key: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
