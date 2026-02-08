"""Case usage tracking for week-based limits.

Marketing plan model: 1 case/week for Free users instead of 5 photos/month.
A "case" = one diagnosis session (can include multiple photos).
"""
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Column, DateTime, Integer, String

from .base import Base


class CaseUsage(Base):
    """Weekly usage of diagnosis cases per user."""

    __tablename__ = "case_usage"

    user_id = Column(BigInteger, primary_key=True)
    week = Column(String(8), primary_key=True)  # YYYY-Www (ISO week format)
    cases_used = Column(Integer, nullable=False, server_default="0")
    last_case_id = Column(BigInteger, nullable=True)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


__all__ = ["CaseUsage"]







