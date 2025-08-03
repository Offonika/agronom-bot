from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Enum, Integer, String

from app.models.base import Base


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=False)
    amount = Column(Integer)
    currency = Column(String)
    provider = Column(String)
    external_id = Column(String)
    prolong_months = Column(Integer)
    autopay = Column(Boolean, default=False)
    autopay_binding_id = Column(String, nullable=True)
    status = Column(
        Enum(
            "pending",
            "success",
            "fail",
            "cancel",
            "bank_error",
            name="payment_status",
        ),
        nullable=False,
    )
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
