from datetime import datetime, timedelta, timezone

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, String, false

from app.models.base import Base

# Trial period duration (24 hours)
TRIAL_PERIOD_HOURS = 24


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    tg_id = Column(BigInteger, nullable=False)
    api_key = Column(String(64))
    pro_expires_at = Column(DateTime)
    autopay_enabled = Column(Boolean, default=False)
    autopay_rebill_id = Column(String, nullable=True)
    opt_in = Column(Boolean, default=False)
    is_beta = Column(Boolean, default=False, server_default=false(), nullable=False)
    beta_onboarded_at = Column(DateTime(timezone=True))
    beta_survey_completed_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # Marketing: 24h trial period
    trial_ends_at = Column(DateTime(timezone=True), nullable=True)

    # Marketing: UTM tracking
    utm_source = Column(String(64), nullable=True)
    utm_medium = Column(String(64), nullable=True)
    utm_campaign = Column(String(128), nullable=True)

    def set_trial_period(self) -> None:
        """Set trial_ends_at to 24 hours from now."""
        self.trial_ends_at = datetime.now(timezone.utc) + timedelta(hours=TRIAL_PERIOD_HOURS)

    def is_in_trial(self) -> bool:
        """Check if user is still in trial period."""
        if not self.trial_ends_at:
            return False
        now = datetime.now(timezone.utc)
        trial_end = self.trial_ends_at
        if trial_end.tzinfo is None:
            trial_end = trial_end.replace(tzinfo=timezone.utc)
        return now < trial_end


__all__ = ["User", "TRIAL_PERIOD_HOURS"]
