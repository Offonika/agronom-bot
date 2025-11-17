from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import PlanSession

settings = Settings()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _compute_expiration(ttl_hours: int | None) -> datetime:
    ttl = ttl_hours if ttl_hours and ttl_hours > 0 else settings.plan_session_ttl_h
    return _now() + timedelta(hours=ttl or 6)


def _purge_old_sessions(db: Session) -> None:
    max_age = settings.plan_session_max_age_h
    if not max_age or max_age <= 0:
        return
    threshold = _now() - timedelta(hours=max_age)
    db.execute(
        delete(PlanSession).where(PlanSession.expires_at < _now(), PlanSession.updated_at < threshold)
    )


def upsert_plan_session(
    db: Session,
    *,
    user_id: int,
    token: str,
    diagnosis_payload: dict[str, Any],
    current_step: str,
    state: dict[str, Any],
    recent_diagnosis_id: int | None = None,
    object_id: int | None = None,
    plan_id: int | None = None,
    ttl_hours: int | None = None,
) -> PlanSession:
    if not diagnosis_payload:
        raise ValueError('diagnosis_payload is required')
    record = (
        db.query(PlanSession)
        .filter(PlanSession.user_id == user_id, PlanSession.token == token)
        .one_or_none()
    )
    expires_at = _compute_expiration(ttl_hours)
    now = _now()
    if record:
        record.diagnosis_payload = diagnosis_payload
        record.current_step = current_step
        record.state = state or {}
        record.recent_diagnosis_id = recent_diagnosis_id
        record.object_id = object_id
        record.plan_id = plan_id
        record.expires_at = expires_at
        record.updated_at = now
    else:
        record = PlanSession(
            user_id=user_id,
            token=token,
            diagnosis_payload=diagnosis_payload,
            current_step=current_step,
            state=state or {},
            recent_diagnosis_id=recent_diagnosis_id,
            object_id=object_id,
            plan_id=plan_id,
            expires_at=expires_at,
            updated_at=now,
        )
        db.add(record)
    _purge_old_sessions(db)
    db.commit()
    db.refresh(record)
    return record


def get_plan_session_by_token(db: Session, *, user_id: int, token: str) -> PlanSession | None:
    return (
        db.query(PlanSession)
        .filter(PlanSession.user_id == user_id, PlanSession.token == token)
        .one_or_none()
    )


def get_latest_plan_session(db: Session, *, user_id: int) -> PlanSession | None:
    return (
        db.query(PlanSession)
        .filter(PlanSession.user_id == user_id)
        .order_by(PlanSession.created_at.desc())
        .first()
    )


def get_plan_session_by_plan(db: Session, *, user_id: int, plan_id: int) -> PlanSession | None:
    return (
        db.query(PlanSession)
        .filter(PlanSession.user_id == user_id, PlanSession.plan_id == plan_id)
        .order_by(PlanSession.updated_at.desc())
        .first()
    )


def update_plan_session_fields(
    db: Session,
    *,
    user_id: int,
    session_id: int,
    diagnosis_payload: dict[str, Any] | None = None,
    current_step: str | None = None,
    state: dict[str, Any] | None = None,
    recent_diagnosis_id: int | None = None,
    object_id: int | None = None,
    plan_id: int | None = None,
    ttl_hours: int | None = None,
) -> PlanSession | None:
    record = (
        db.query(PlanSession)
        .filter(PlanSession.id == session_id, PlanSession.user_id == user_id)
        .one_or_none()
    )
    if not record:
        return None
    if diagnosis_payload is not None:
        record.diagnosis_payload = diagnosis_payload
    if current_step is not None:
        record.current_step = current_step
    if state is not None:
        record.state = state
    if recent_diagnosis_id is not None:
        record.recent_diagnosis_id = recent_diagnosis_id
    if object_id is not None:
        record.object_id = object_id
    if plan_id is not None:
        record.plan_id = plan_id
    if ttl_hours is not None:
        record.expires_at = _compute_expiration(ttl_hours)
    record.updated_at = _now()
    db.commit()
    db.refresh(record)
    return record


def delete_plan_session(
    db: Session,
    *,
    user_id: int,
    token: str | None = None,
    plan_id: int | None = None,
) -> int:
    query = db.query(PlanSession).filter(PlanSession.user_id == user_id)
    if token:
        query = query.filter(PlanSession.token == token)
    if plan_id:
        query = query.filter(PlanSession.plan_id == plan_id)
    deleted = query.delete()
    db.commit()
    return deleted


def delete_plan_sessions_by_plan(db: Session, *, user_id: int, plan_id: int) -> int:
    deleted = (
        db.query(PlanSession)
        .filter(PlanSession.user_id == user_id, PlanSession.plan_id == plan_id)
        .delete()
    )
    db.commit()
    return deleted
