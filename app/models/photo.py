from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, Boolean
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
    status = Column(String)
    ts = Column(DateTime, default=datetime.utcnow)
    deleted = Column(Boolean, default=False)
