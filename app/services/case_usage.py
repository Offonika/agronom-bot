"""Case usage service for week-based limits.

Marketing plan v2.4 requirements:
- Free users get 1 case per week (not 5 photos per month)
- 24h trial period for new users (no limits)
- Low confidence diagnoses don't consume a case
- Same plant within 10 days = same case (no additional usage)
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import NamedTuple

from sqlalchemy import text

from app import db as db_module
from app.config import Settings

settings = Settings()


class CaseUsageInfo(NamedTuple):
    """Usage info for current week."""
    cases_used: int
    cases_limit: int
    week_key: str
    last_case_id: int | None
    is_trial: bool
    trial_ends_at: datetime | None
    is_pro: bool
    is_beta: bool


def get_iso_week_key(dt: datetime | None = None) -> str:
    """Get ISO week key in format YYYY-Www (e.g., 2026-W01)."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    iso_cal = dt.isocalendar()
    return f"{iso_cal.year}-W{iso_cal.week:02d}"


def get_case_usage_sync(user_id: int) -> CaseUsageInfo:
    """Get current case usage for user (synchronous, for use with asyncio.to_thread)."""
    with db_module.SessionLocal() as db:
        week_key = get_iso_week_key()

        # Get usage for current week
        usage_row = db.execute(
            text(
                "SELECT cases_used, last_case_id FROM case_usage "
                "WHERE user_id = :uid AND week = :week"
            ),
            {"uid": user_id, "week": week_key},
        ).first()

        cases_used = usage_row[0] if usage_row else 0
        last_case_id = usage_row[1] if usage_row else None

        # Get user info
        user_row = db.execute(
            text(
                "SELECT pro_expires_at, is_beta, trial_ends_at FROM users WHERE id = :uid"
            ),
            {"uid": user_id},
        ).first()

        pro_expires = None
        is_beta = False
        trial_ends_at = None

        if user_row:
            pro_expires = user_row[0]
            is_beta = bool(user_row[1]) if user_row[1] is not None else False
            trial_ends_at = user_row[2]

            # Normalize datetime
            if isinstance(pro_expires, str):
                pro_expires = datetime.fromisoformat(pro_expires)
            if pro_expires and pro_expires.tzinfo is None:
                pro_expires = pro_expires.replace(tzinfo=timezone.utc)

            if isinstance(trial_ends_at, str):
                trial_ends_at = datetime.fromisoformat(trial_ends_at)
            if trial_ends_at and trial_ends_at.tzinfo is None:
                trial_ends_at = trial_ends_at.replace(tzinfo=timezone.utc)

        now_utc = datetime.now(timezone.utc)
        is_pro = pro_expires is not None and pro_expires > now_utc
        is_trial = trial_ends_at is not None and trial_ends_at > now_utc

        return CaseUsageInfo(
            cases_used=cases_used,
            cases_limit=settings.free_weekly_cases,
            week_key=week_key,
            last_case_id=last_case_id,
            is_trial=is_trial,
            trial_ends_at=trial_ends_at,
            is_pro=is_pro,
            is_beta=is_beta,
        )


def increment_case_usage_sync(user_id: int, case_id: int | None = None) -> int:
    """Increment case usage for current week. Returns new count."""
    with db_module.SessionLocal() as db:
        week_key = get_iso_week_key()

        db.execute(
            text(
                "INSERT INTO case_usage (user_id, week, cases_used, last_case_id, updated_at) "
                "VALUES (:uid, :week, 1, :case_id, CURRENT_TIMESTAMP) "
                "ON CONFLICT (user_id, week) DO UPDATE "
                "SET cases_used = case_usage.cases_used + 1, "
                "last_case_id = COALESCE(:case_id, case_usage.last_case_id), "
                "updated_at = CURRENT_TIMESTAMP"
            ),
            {"uid": user_id, "week": week_key, "case_id": case_id},
        )
        db.commit()

        new_count = db.execute(
            text(
                "SELECT cases_used FROM case_usage WHERE user_id = :uid AND week = :week"
            ),
            {"uid": user_id, "week": week_key},
        ).scalar_one()

        return new_count


def update_last_case_id_sync(user_id: int, case_id: int) -> None:
    """Update last_case_id without incrementing usage (for same plant scenario)."""
    with db_module.SessionLocal() as db:
        week_key = get_iso_week_key()

        db.execute(
            text(
                "INSERT INTO case_usage (user_id, week, cases_used, last_case_id, updated_at) "
                "VALUES (:uid, :week, 0, :case_id, CURRENT_TIMESTAMP) "
                "ON CONFLICT (user_id, week) DO UPDATE "
                "SET last_case_id = :case_id, updated_at = CURRENT_TIMESTAMP"
            ),
            {"uid": user_id, "week": week_key, "case_id": case_id},
        )
        db.commit()


def get_recent_case_for_same_plant_sync(
    user_id: int,
    max_age_days: int | None = None,
) -> dict | None:
    """
    Get the most recent case for user within the "same plant" window.
    Used for "Is this the same plant?" flow.
    """
    if max_age_days is None:
        max_age_days = settings.same_plant_check_days

    with db_module.SessionLocal() as db:
        cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)

        row = db.execute(
            text(
                "SELECT id, object_id, crop, disease, confidence, created_at "
                "FROM cases "
                "WHERE user_id = :uid AND created_at >= :cutoff "
                "ORDER BY created_at DESC "
                "LIMIT 1"
            ),
            {"uid": user_id, "cutoff": cutoff},
        ).first()

        if not row:
            return None

        return {
            "case_id": row[0],
            "object_id": row[1],
            "crop": row[2],
            "disease": row[3],
            "confidence": row[4],
            "created_at": row[5],
        }


def set_trial_period_sync(user_id: int) -> datetime:
    """Set trial period for new user. Returns trial_ends_at."""
    with db_module.SessionLocal() as db:
        trial_ends_at = datetime.now(timezone.utc) + timedelta(hours=24)

        db.execute(
            text(
                "UPDATE users SET trial_ends_at = :trial_ends "
                "WHERE id = :uid AND trial_ends_at IS NULL"
            ),
            {"uid": user_id, "trial_ends": trial_ends_at},
        )
        db.commit()

        return trial_ends_at


def save_utm_sync(
    user_id: int,
    source: str | None = None,
    medium: str | None = None,
    campaign: str | None = None,
) -> None:
    """Save UTM parameters for user (only if not already set)."""
    if not any([source, medium, campaign]):
        return

    with db_module.SessionLocal() as db:
        # Only update if UTM is not already set
        db.execute(
            text(
                "UPDATE users SET "
                "utm_source = COALESCE(utm_source, :source), "
                "utm_medium = COALESCE(utm_medium, :medium), "
                "utm_campaign = COALESCE(utm_campaign, :campaign) "
                "WHERE id = :uid"
            ),
            {"uid": user_id, "source": source, "medium": medium, "campaign": campaign},
        )
        db.commit()


__all__ = [
    "CaseUsageInfo",
    "get_iso_week_key",
    "get_case_usage_sync",
    "increment_case_usage_sync",
    "update_last_case_id_sync",
    "get_recent_case_for_same_plant_sync",
    "set_trial_period_sync",
    "save_utm_sync",
]







