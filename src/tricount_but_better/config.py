"""Application settings, loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

VlmProvider = Literal["agent_sdk", "messages_api", "disabled"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- core ---
    app_name: str = "Tricount but better"
    environment: Literal["dev", "test", "prod"] = "dev"
    # A single file, kept next to the uploads. Point at Postgres instead by
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

    # --- uploads ---
    upload_dir: Path = Path("var/uploads")
    max_upload_mb: int = 12
    max_receipt_images: int = 8

    # --- VLM ---
    # agent_sdk   -> claude-agent-sdk, authenticates with CLAUDE_CODE_OAUTH_TOKEN
    # messages_api-> anthropic SDK, authenticates with ANTHROPIC_API_KEY
    vlm_provider: VlmProvider = "agent_sdk"
    vlm_model: str = "claude-sonnet-5"
    vlm_timeout_seconds: int = 180
    vlm_max_cost_usd: float = 0.50

    claude_code_oauth_token: str | None = None
    # Local development convenience: fall back to whatever the Claude Code CLI
    # is already logged in as. Leave false on a server -- a deployment should
    # fail loudly rather than run on some operator's personal credentials.
    claude_use_ambient_login: bool = False
    claude_cli_path: str | None = None
    anthropic_api_key: str | None = None

    # --- egress / geo-proxy ---
    # Set ONE of these when the host cannot reach api.anthropic.com directly.
    #   anthropic_proxy_url : HTTP or SOCKS5 proxy, e.g. socks5://user:pass@host:1080
    #   anthropic_base_url  : reverse-proxy relay you control abroad, e.g. https://relay.example.com
    # Leaving both unset means direct egress (correct when a WireGuard tunnel
    # already covers the whole process -- see deploy/README.md).
    anthropic_proxy_url: str | None = None
    anthropic_base_url: str | None = None

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
