from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Enum
from app.models.base import Base
from datetime import datetime

class Photo(Base):
    __tablename__ = "photos"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    file_id = Column(String, nullable=False)
    crop = Column(String)
    disease = Column(String)
    confidence = Column(Float)
    status = Column(
        Enum("pending", "ok", "retrying", name="photo_status"),
        nullable=False,
        server_default="pending",
    )
    ts = Column(DateTime, default=datetime.utcnow)
    deleted = Column(Boolean, default=False)
