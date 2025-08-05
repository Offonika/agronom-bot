from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    tg_id = Column(BigInteger, nullable=False)
    pro_expires_at = Column(DateTime)
    autopay_enabled = Column(Boolean, default=False)
    opt_in = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


__all__ = ["User"]

