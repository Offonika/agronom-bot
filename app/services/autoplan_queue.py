from __future__ import annotations

import json
import logging
import os

import redis

logger = logging.getLogger(__name__)

QUEUE_NAME = os.getenv("AUTOPLAN_QUEUE", "autoplan")


class AutoplanQueue:
    """Простейший продьюсер BullMQ (добавляет job через Redis по формату BullMQ v4)."""

    def __init__(self, redis_url: str | None = None):
        url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")
        self.client = redis.from_url(url)

    def add_run(self, run_id: int) -> None:
        # BullMQ v4: stream/commands через redis, упрощённо пишем в wait-список
        # Используем простейший API: XADD на stream 'bull:<queue>:events' не обязателен, достаточно LPUSH в wait.
        # Полный протокол BullMQ сложный; поллер в worker/autoplan.js уже подхватывает pending из БД.
        try:
            # Сигнал в events stream (best-effort)
            self.client.xadd(f"bull:{QUEUE_NAME}:events", {"event": "added", "jobId": str(run_id)})
        except Exception as exc:  # pragma: no cover
            logger.debug("autoplan xadd failed: %s", exc)

        # Используем резервный поллер в воркере по autoplan_runs, поэтому jobId = run_id
        try:
            payload = json.dumps({"runId": run_id})
            self.client.lpush(f"bull:{QUEUE_NAME}:wait", payload)
        except Exception as exc:
            logger.exception("Failed to enqueue autoplan run_id=%s: %s", run_id, exc)
            raise


def get_autoplan_queue() -> AutoplanQueue:
    return AutoplanQueue()
