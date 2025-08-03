from __future__ import annotations

from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application configuration loaded from environment variables."""

    hmac_secret: str = "test-hmac-secret"
    hmac_secret_partner: str = Field(
        "test-hmac-partner", alias="HMAC_SECRET_PARTNER"
    )
    tinkoff_terminal_key: str = "tinkoff-terminal-key"
    tinkoff_secret_key: str = "tinkoff-secret-key"
    free_monthly_limit: int = 5
    paywall_enabled: bool = Field(True, alias="PAYWALL_ENABLED")

    api_key: str = "test-api-key"

    database_url: str = Field("sqlite:///./app.db", alias="DATABASE_URL")
    db_create_all: bool = Field(False, alias="DB_CREATE_ALL")

    s3_bucket: str = "agronom"
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_public_url: str | None = None

    model_config = ConfigDict(
        extra="ignore",
        env_file=".env",
        case_sensitive=False,
    )
