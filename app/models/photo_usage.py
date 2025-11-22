from datetime import datetime, timezone
from sqlalchemy import Column, Integer, BigInteger, String, DateTime

from .base import Base


class PhotoUsage(Base):
    """Monthly usage of diagnose requests per user."""

    __tablename__ = "photo_usage"

    user_id = Column(BigInteger, primary_key=True)
    month = Column(String(7), primary_key=True)
    used = Column(Integer, nullable=False, server_default="0")
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
