from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Enum, Integer, BigInteger, String

from app.models.base import Base


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    amount = Column(Integer)
    currency = Column(String)
    provider = Column(String)
    external_id = Column(String)
    provider_payment_id = Column(String, nullable=True)
    idempotency_key = Column(String, nullable=True)
    payment_url = Column(String, nullable=True)
    sbp_url = Column(String, nullable=True)
    autopay_charge_id = Column(String, unique=True, nullable=True)
    autopay_cycle_key = Column(String, nullable=True)
    autopay_attempt = Column(Integer, nullable=True)
    autopay_next_retry_at = Column(DateTime, nullable=True)
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
