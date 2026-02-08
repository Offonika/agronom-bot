from datetime import datetime, timezone

from sqlalchemy import BigInteger, Column, DateTime, Float, JSON, Text

from app.models.base import Base


class Case(Base):
    __tablename__ = "cases"

    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    object_id = Column(BigInteger)
    crop = Column(Text)
    disease = Column(Text)
    confidence = Column(Float)
    raw_ai = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


__all__ = ["Case"]
