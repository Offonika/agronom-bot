import logging
from datetime import datetime, timezone, timedelta
import os
from sqlalchemy import create_engine, text

from app.logger import setup_logging


def check_queue(threshold_minutes: int = 60) -> None:
    """Log warning if pending photos older than threshold exist."""
    db_url = os.getenv("DATABASE_URL", "sqlite:///./app.db")
    engine = create_engine(db_url, future=True)

    with engine.connect() as conn:
        result = conn.execute(
            text("SELECT MIN(ts), COUNT(*) FROM photos WHERE status IN ('pending', 'retrying')")
        )
        row = result.one()
        oldest_ts, count = row[0], row[1]

    if not oldest_ts or count == 0:
        logging.info("queue empty")
        return

    age = datetime.now(timezone.utc) - oldest_ts
    if age > timedelta(minutes=threshold_minutes):
        logging.warning(
            "queue stalled: pending=%s oldest_age_min=%.1f",
            count,
            age.total_seconds() / 60,
        )
    else:
        logging.info(
            "queue healthy: pending=%s oldest_age_min=%.1f",
            count,
            age.total_seconds() / 60,
        )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Check pending photo queue")
    parser.add_argument(
        "--threshold",
        type=int,
        default=60,
        help="minutes before warning",
    )
    args = parser.parse_args()

    setup_logging()
    check_queue(args.threshold)


if __name__ == "__main__":
    main()
