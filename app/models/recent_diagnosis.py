from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, JSON

from app.models.base import Base


class RecentDiagnosis(Base):
    __tablename__ = "recent_diagnoses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False)
    object_id = Column(Integer)
    case_id = Column(Integer)
    plan_id = Column(Integer)
    diagnosis_payload = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
