from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Enum
from app.models.base import Base
from datetime import datetime, timezone


class Photo(Base):
    __tablename__ = "photos"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    file_id = Column(String, nullable=False)
    file_unique_id = Column(String)
    width = Column(Integer)
    height = Column(Integer)
    file_size = Column(Integer)
    crop = Column(String)
    disease = Column(String)
    confidence = Column(Float)
    status = Column(
        Enum("pending", "ok", "retrying", name="photo_status"),
        nullable=False,
        server_default="pending",
    )
    ts = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    deleted = Column(Boolean, default=False)
