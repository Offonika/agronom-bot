from sqlalchemy import (
    Column,
    Integer,
    BigInteger,
    String,
    Float,
    DateTime,
    Boolean,
    Enum,
)
from app.models.base import Base
from datetime import datetime, timezone

from .error_code import ErrorCode


class Photo(Base):
    __tablename__ = "photos"

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    file_id = Column(String, nullable=False)
    file_unique_id = Column(String)
    width = Column(Integer)
    height = Column(Integer)
    file_size = Column(Integer)
    crop = Column(String)
    disease = Column(String)
    confidence = Column(Float)
    roi = Column(Float)
    retry_attempts = Column(Integer, nullable=False, default=0)
    status = Column(
        Enum("pending", "ok", "retrying", "failed", name="photo_status"),
        nullable=False,
        server_default="pending",
    )
    error_code = Column(Enum(ErrorCode, name="error_code"), nullable=True)
    ts = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    deleted = Column(Boolean, default=False)
