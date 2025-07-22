from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime

from app.models.base import Base


class PartnerOrder(Base):
    __tablename__ = "partner_orders"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    order_id = Column(String)
    protocol_id = Column(Integer)
    price_kopeks = Column(Integer)
    signature = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    status = Column(String, default="new")
