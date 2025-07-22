from sqlalchemy import Column, Integer, String
from app.models.base import Base


class PhotoQuota(Base):
    __tablename__ = "photo_quota"

    user_id = Column(Integer, primary_key=True)
    used_count = Column(Integer)
    month_year = Column(String(7))  # пример: "2025-07"
