from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application configuration loaded from environment variables."""

    hmac_secret: str = "test-hmac-secret"
    free_monthly_limit: int = 5

    api_key: str = "test-api-key"

    database_url: str = "sqlite:///./app.db"
    db_create_all: bool = False

    s3_bucket: str = "agronom"
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_public_url: str | None = None

    class Config:
        env_file = ".env"
        case_sensitive = False
