from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, JSON, String

from app.models.base import Base


class PlanSession(Base):
    __tablename__ = "plan_sessions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False)
    recent_diagnosis_id = Column(Integer)
    diagnosis_payload = Column(JSON, nullable=False)
    token = Column(String(64), nullable=False, unique=True)
    object_id = Column(Integer)
    plan_id = Column(Integer)
    current_step = Column(String(64), nullable=False, default="choose_object")
    state = Column(JSON, nullable=False, default=dict)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
