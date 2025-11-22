from sqlalchemy import Column, Integer, BigInteger, String, DateTime
from datetime import datetime, timezone

from app.models.base import Base


class PartnerOrder(Base):
    __tablename__ = "partner_orders"

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    order_id = Column(String, unique=True)
    protocol_id = Column(Integer)
    price_kopeks = Column(Integer)
    signature = Column(String)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    status = Column(String, default="new")
