from __future__ import annotations

from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings

DEFAULT_CATALOG_URL = (
    "https://mcx.gov.ru/ministry/departments/"
    "departament-rastenievodstva-mekhanizatsii-khimizatsii-"
    "zashchity-rasteniy/industry-information/"
    "info-gosudarstvennaya-usluga-po-gosudarstvennoy-registratsii-"
    "pestitsidov-i-agrokhimikatov/"
)


class Settings(BaseSettings):
    """Application configuration loaded from environment variables."""

    hmac_secret: str = "test-hmac-secret"
    jwt_secret: str = Field("test-jwt-secret", alias="JWT_SECRET")
    hmac_secret_partner: str = Field(
        "test-hmac-partner", alias="HMAC_SECRET_PARTNER"
    )
    tinkoff_ips: list[str] = Field(
        default_factory=lambda: ["127.0.0.1", "testclient"]
    )
    partner_ips: list[str] = Field(
        default_factory=lambda: ["127.0.0.1", "testclient"]
    )
    trusted_proxies: list[str] = Field(
        default_factory=lambda: ["127.0.0.1", "testclient"]
    )
    tinkoff_terminal_key: str = "tinkoff-terminal-key"
    tinkoff_secret_key: str = "tinkoff-secret-key"
    free_monthly_limit: int = 5
    paywall_enabled: bool = Field(True, alias="PAYWALL_ENABLED")

    api_key: str = "test-api-key"

    database_url: str = Field("sqlite:////tmp/agronom_test.db", alias="DATABASE_URL")
    db_create_all: bool = Field(False, alias="DB_CREATE_ALL")

    redis_url: str = Field("redis://localhost:6379", alias="REDIS_URL")

    s3_bucket: str = "agronom"
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_public_url: str | None = None

    catalog_main_url: str = Field(DEFAULT_CATALOG_URL, alias="CATALOG_MAIN_URL")
    catalog_pesticide_url: str = Field(
        DEFAULT_CATALOG_URL, alias="CATALOG_PESTICIDE_URL"
    )
    catalog_referer: str = Field(
        DEFAULT_CATALOG_URL,
        alias="CATALOG_REFERER",
        description="Referer header to use for catalog downloads",
    )
    catalog_agrochem_url: str = Field(
        DEFAULT_CATALOG_URL, alias="CATALOG_AGROCHEM_URL"
    )
    catalog_ssl_verify: bool = Field(
        True,
        alias="CATALOG_SSL_VERIFY",
        description="Verify TLS certificates when downloading catalog data",
    )
    catalog_ca_bundle: str | None = Field(
        None,
        alias="CATALOG_CA_BUNDLE",
        description="Path to a custom CA bundle for catalog requests",
    )
    recent_diag_ttl_h: int = Field(24, alias="RECENT_DIAG_TTL_H")
    recent_diag_max_age_h: int = Field(72, alias="RECENT_DIAG_MAX_AGE_H")
    plan_session_ttl_h: int = Field(6, alias="PLAN_SESSION_TTL_H")
    plan_session_max_age_h: int = Field(24, alias="PLAN_SESSION_MAX_AGE_H")

    model_config = ConfigDict(
        extra="ignore",
        env_file=".env",
        case_sensitive=False,
    )
