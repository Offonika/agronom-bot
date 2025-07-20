from sqlalchemy import Column, Integer, String, ForeignKey, DateTime
from app.models.base import Base
from datetime import datetime

class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    amount = Column(Integer)
    source = Column(String)
    status = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
