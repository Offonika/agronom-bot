import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Tuple

import requests
from sqlalchemy import create_engine, text

from app.logger import setup_logging

PROM_URL = os.getenv("PROMETHEUS_URL", "http://localhost:9090")
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")


def prom_query(query: str) -> float:
    """Run instant query against Prometheus and return numeric value."""
    url = f"{PROM_URL}/api/v1/query"
    resp = requests.get(url, params={"query": query}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "success" or not data["data"]["result"]:
        return 0.0
    return float(data["data"]["result"][0]["value"][1])


def collect_prom_metrics() -> Tuple[float, float]:
    """Return error rate and average latency from Prometheus."""
    error_rate = prom_query(
        "sum(rate(http_requests_total{status=~\"5..\"}[1h])) / "
        "sum(rate(http_requests_total[1h]))"
    )
    latency = prom_query(
        "rate(http_request_duration_seconds_sum[1h]) / "
        "rate(http_request_duration_seconds_count[1h])"
    )
    return error_rate, latency


def collect_db_metrics() -> Tuple[int, int, int, int]:
    """Return MAU, WAU, active subscriptions and successful payments."""
    engine = create_engine(DB_URL, future=True)
    now = datetime.now(timezone.utc)
    with engine.connect() as conn:
        mau = conn.execute(
            text(
                "SELECT COUNT(DISTINCT user_id) FROM events "
                "WHERE ts >= :ts"
            ),
            {"ts": now - timedelta(days=30)},
        ).scalar_one()
        wau = conn.execute(
            text(
                "SELECT COUNT(DISTINCT user_id) FROM events "
                "WHERE ts >= :ts"
            ),
            {"ts": now - timedelta(days=7)},
        ).scalar_one()
        subs = conn.execute(
            text(
                "SELECT COUNT(*) FROM users WHERE pro_expires_at >= :ts"
            ),
            {"ts": now},
        ).scalar_one()
        payments = conn.execute(
            text("SELECT COUNT(*) FROM payments WHERE status='success'"),
        ).scalar_one()
    return int(mau), int(wau), int(subs), int(payments)


def make_report(mau: int, wau: int, subs: int, payments: int, error_rate: float, latency: float) -> str:
    """Build Markdown report for Slack."""
    lines = [
        f"### Metrics Report {datetime.now(timezone.utc):%Y-%m-%d}",
        f"*MAU:* {mau}",
        f"*WAU:* {wau}",
        f"*Active subscriptions:* {subs}",
        f"*Successful payments:* {payments}",
        f"*Error rate:* {error_rate * 100:.2f}%",
        f"*Avg latency:* {latency:.2f}s",
    ]
    return "\n".join(lines)


def send_slack(text: str) -> None:
    """Send text message to Slack via webhook."""
    if not SLACK_WEBHOOK_URL:
        logging.warning("SLACK_WEBHOOK_URL not configured")
        return
    resp = requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=10)
    resp.raise_for_status()


def main() -> None:
    setup_logging()
    error_rate, latency = collect_prom_metrics()
    mau, wau, subs, payments = collect_db_metrics()
    report = make_report(mau, wau, subs, payments, error_rate, latency)
    logging.info("sending report")
    send_slack(report)


if __name__ == "__main__":
    main()
