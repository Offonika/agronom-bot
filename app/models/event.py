from datetime import datetime, timezone

from sqlalchemy import Column, Integer, BigInteger, String, DateTime

from .base import Base


class Event(Base):
    """Analytics event."""

    __tablename__ = "events"

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    event = Column(String, nullable=False)
    ts = Column(DateTime, default=lambda: datetime.now(timezone.utc))
