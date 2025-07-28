from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.models import PhotoUsage


def test_usage_reset_cron():
    """Old monthly counters are zeroed by the reset worker."""
    from app.db import SessionLocal

    old_month = "2020-01"
    with SessionLocal() as session:
        session.add(PhotoUsage(user_id=1, month=old_month, used=3))
        session.commit()

        current_month = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%Y-%m")
        session.execute(
            text("UPDATE photo_usage SET used=0 WHERE month < :m"),
            {"m": current_month},
        )
        session.commit()

        usage = session.get(PhotoUsage, {"user_id": 1, "month": old_month})
        assert usage.used == 0
