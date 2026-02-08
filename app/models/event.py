from datetime import datetime, timezone

from sqlalchemy import Column, Integer, BigInteger, String, DateTime

from .base import Base


class Event(Base):
    """Analytics event."""

    __tablename__ = "analytics_events"

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    event = Column(String, nullable=False)
    utm_source = Column(String(64), nullable=True)
    utm_medium = Column(String(64), nullable=True)
    utm_campaign = Column(String(128), nullable=True)
    ts = Column(DateTime, default=lambda: datetime.now(timezone.utc))
