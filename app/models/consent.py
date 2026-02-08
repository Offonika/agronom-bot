from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, Column, DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.dialects.postgresql import JSONB

from app.models.base import Base


class ConsentEvent(Base):
    __tablename__ = "consent_events"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    doc_type = Column(String, nullable=False)
    doc_version = Column(String, nullable=False)
    action = Column(String, nullable=False)
    source = Column(String, nullable=False)
    occurred_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    meta = Column(JSONB().with_variant(JSON, "sqlite"), nullable=False, default=dict)


class UserConsent(Base):
    __tablename__ = "user_consents"

    user_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    doc_type = Column(String, primary_key=True)
    doc_version = Column(String, nullable=False)
    status = Column(Boolean, nullable=False)
    source = Column(String, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


__all__ = ["ConsentEvent", "UserConsent"]
