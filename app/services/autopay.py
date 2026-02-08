from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Iterable


DEFAULT_RETRY_DELAYS_HOURS = "24,48"
DEFAULT_RETRY_STATUSES = {"fail", "bank_error"}


def autopay_cycle_key(due_at: datetime) -> str:
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)
    return due_at.astimezone(timezone.utc).strftime("%Y%m%d")


def _parse_int_list(raw: str) -> list[int]:
    values: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            continue
        if value > 0:
            values.append(value)
    return values


def parse_retry_delays(raw: str | None = None) -> list[timedelta]:
    if raw is None:
        raw = os.getenv("AUTOPAY_RETRY_DELAYS_HOURS", DEFAULT_RETRY_DELAYS_HOURS)
    hours = _parse_int_list(raw)
    return [timedelta(hours=value) for value in hours]


def retryable_statuses(raw: str | None = None) -> set[str]:
    if raw is None:
        raw = os.getenv("AUTOPAY_RETRY_STATUSES", "")
    if not raw:
        return set(DEFAULT_RETRY_STATUSES)
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def max_attempts(delays: Iterable[timedelta]) -> int:
    delays_list = list(delays)
    return 1 + len(delays_list)


def next_retry_at(attempt: int, now: datetime, delays: list[timedelta]) -> datetime | None:
    if attempt < 1:
        return None
    index = attempt - 1
    if index >= len(delays):
        return None
    return now + delays[index]


def retry_due(
    *,
    attempt: int | None,
    created_at: datetime | None,
    next_retry_at_value: datetime | None,
    now: datetime,
    delays: list[timedelta],
) -> bool:
    if attempt is None or attempt < 1:
        return False
    if attempt - 1 >= len(delays):
        return False
    candidate = next_retry_at_value
    if candidate is None and created_at is not None:
        candidate = created_at + delays[attempt - 1]
    if candidate is None:
        return False
    return candidate <= now
