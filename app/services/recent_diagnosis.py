from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import RecentDiagnosis


def save_recent_diagnosis(
    db: Session,
    *,
    user_id: int,
    payload: dict[str, Any],
    object_id: int | None = None,
    case_id: int | None = None,
    ttl_hours: int = 24,
    max_age_hours: int = 72,
) -> RecentDiagnosis:
    """Persist recent diagnosis payload for reuse."""
    if not payload:
        raise ValueError("payload must be provided for recent diagnosis record")

    now = datetime.now(timezone.utc)
    ttl = ttl_hours if ttl_hours and ttl_hours > 0 else 24
    expires_at = now + timedelta(hours=ttl)
    record = RecentDiagnosis(
        user_id=user_id,
        object_id=object_id,
        case_id=case_id,
        diagnosis_payload=payload,
        expires_at=expires_at,
    )
    db.add(record)
    if max_age_hours and max_age_hours > 0:
        cutoff = now - timedelta(hours=max_age_hours)
        db.execute(delete(RecentDiagnosis).where(RecentDiagnosis.expires_at < cutoff))
    db.commit()
    db.refresh(record)
    return record


def get_latest_recent_diagnosis(
    db: Session,
    *,
    user_id: int,
    include_expired: bool = False,
) -> RecentDiagnosis | None:
    query = db.query(RecentDiagnosis).filter(RecentDiagnosis.user_id == user_id)
    if not include_expired:
        query = query.filter(RecentDiagnosis.expires_at > datetime.now(timezone.utc))
    return (
        query.order_by(RecentDiagnosis.created_at.desc(), RecentDiagnosis.id.desc())
        .limit(1)
        .first()
    )


def get_recent_diagnosis_by_id(
    db: Session,
    *,
    user_id: int,
    diagnosis_id: int,
) -> RecentDiagnosis | None:
    return (
        db.query(RecentDiagnosis)
        .filter(RecentDiagnosis.user_id == user_id, RecentDiagnosis.id == diagnosis_id)
        .first()
    )
