from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)

from .base import Base


def _now():
    return datetime.now(timezone.utc)


class DiagnosisFeedback(Base):
    __tablename__ = "diagnosis_feedback"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    case_id = Column(
        BigInteger, ForeignKey("cases.id", ondelete="CASCADE"), nullable=False
    )
    q1_confidence_score = Column(Integer, nullable=False)
    q2_clarity_score = Column(Integer)
    q3_comment = Column(Text)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class FollowupFeedback(Base):
    __tablename__ = "followup_feedback"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    case_id = Column(
        BigInteger, ForeignKey("cases.id", ondelete="CASCADE"), nullable=False
    )
    due_at = Column(DateTime(timezone=True))
    retry_at = Column(DateTime(timezone=True))
    sent_at = Column(DateTime(timezone=True))
    answered_at = Column(DateTime(timezone=True))
    attempts = Column(Integer, nullable=False, default=0)
    status = Column(String, nullable=False, default="pending")
    action_choice = Column(String)
    result_choice = Column(String)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class BetaEvent(Base):
    __tablename__ = "beta_events"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    event_type = Column(String, nullable=False)
    payload = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)


__all__ = ["DiagnosisFeedback", "FollowupFeedback", "BetaEvent"]
