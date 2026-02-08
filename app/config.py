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

    hmac_secret: str = Field(..., alias="HMAC_SECRET")
    jwt_secret: str = Field(..., alias="JWT_SECRET")
    hmac_secret_partner: str = Field(..., alias="HMAC_SECRET_PARTNER")
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

    # Legacy: photos per month (deprecated, kept for backwards compat)
    free_monthly_limit: int = 5

    # Marketing plan v2.4: cases per week
    free_weekly_cases: int = Field(1, alias="FREE_WEEKLY_CASES")

    # Marketing plan v2.4: same plant check window (days)
    same_plant_check_days: int = Field(10, alias="SAME_PLANT_CHECK_DAYS")

    paywall_enabled: bool = Field(True, alias="PAYWALL_ENABLED")
    pro_month_price_cents: int = Field(19900, alias="PRO_MONTH_PRICE_CENTS")
    privacy_version: str = Field("1.0", alias="PRIVACY_VERSION")
    offer_version: str = Field("1.0", alias="OFFER_VERSION")
    autopay_version: str = Field("1.0", alias="AUTOPAY_VERSION")
    marketing_version: str = Field("1.0", alias="MARKETING_VERSION")

    api_key: str = Field(..., alias="API_KEY")
    request_signature_ttl_seconds: int = Field(
        300,
        alias="REQUEST_SIGNATURE_TTL_SECONDS",
        description="Allowed clock skew for request signatures (seconds).",
    )
    metrics_token: str | None = Field(
        None,
        alias="METRICS_TOKEN",
        description="Optional token to protect /metrics endpoint.",
    )

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
    beta_houseplants_enabled: bool = Field(
        False,
        alias="BETA_HOUSEPLANTS_ENABLED",
        description="Enable beta mode for indoor plants testers",
    )
    beta_tester_ids: list[int] = Field(
        default_factory=list,
        alias="BETA_TESTER_IDS",
        description="Comma-separated or JSON list of tester user IDs (tg_id or internal id)",
    )
    beta_followup_days: int = Field(
        3,
        alias="BETA_FOLLOWUP_DAYS",
        description="Default delay in days before sending beta follow-up prompt",
    )
    recent_diag_ttl_h: int = Field(24, alias="RECENT_DIAG_TTL_H")
    recent_diag_max_age_h: int = Field(72, alias="RECENT_DIAG_MAX_AGE_H")
    plan_session_ttl_h: int = Field(6, alias="PLAN_SESSION_TTL_H")
    plan_session_max_age_h: int = Field(24, alias="PLAN_SESSION_MAX_AGE_H")
    assistant_enable_stub: bool = Field(
        True,
        alias="ASSISTANT_ENABLE_STUB",
        description="Allow assistant persistence on non-sqlite DBs",
    )

    model_config = ConfigDict(
        extra="ignore",
        env_file=".env",
        case_sensitive=False,
    )
