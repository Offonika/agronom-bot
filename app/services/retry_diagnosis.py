from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import text

from app import db as db_module
from app.models import ErrorCode
from app.services.gpt import call_gpt_vision
from app.services.roi import calculate_roi
from app.services.storage import download_photo

logger = logging.getLogger(__name__)

PHOTO_PENDING_STATUSES = ("pending", "retrying")


@dataclass(slots=True)
class RetryOutcome:
    status: str
    retry_attempts: int
    crop: str | None = None
    disease: str | None = None
    confidence: float | None = None
    roi: float | None = None
    error_code: str | None = None


@dataclass(slots=True)
class RetryCycleStats:
    scanned: int = 0
    succeeded: int = 0
    retried: int = 0
    failed: int = 0


FetchBytesFn = Callable[[str], Awaitable[bytes]]
InferFn = Callable[[str, bytes | None], dict[str, Any]]


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _looks_like_s3_key(file_id: str) -> bool:
    # upload_photo stores keys as "<user_id>/<timestamp>-<uuid>.<ext>".
    # Telegram file_id values do not contain slashes and cannot be fetched from S3.
    return "/" in file_id


async def process_pending_photo(
    *,
    file_id: str,
    retry_attempts: int,
    retry_limit: int,
    fetch_bytes: FetchBytesFn = download_photo,
    infer: InferFn = call_gpt_vision,
) -> RetryOutcome:
    """Run one retry attempt for a pending photo and return desired row state."""
    if not _looks_like_s3_key(file_id):
        return RetryOutcome(
            status="failed",
            retry_attempts=max(retry_attempts, retry_limit),
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )

    if retry_attempts >= retry_limit:
        return RetryOutcome(
            status="failed",
            retry_attempts=retry_attempts,
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )

    attempts = retry_attempts + 1
    try:
        image_bytes = await fetch_bytes(file_id)
        data = await asyncio.to_thread(infer, file_id, image_bytes)
        crop = _clean_text(data.get("crop"))
        disease = _clean_text(data.get("disease"))
        confidence = _safe_float(data.get("confidence"), 0.0)
        if crop and disease:
            roi = calculate_roi(crop, disease)
            return RetryOutcome(
                status="ok",
                retry_attempts=attempts,
                crop=crop,
                disease=disease,
                confidence=confidence,
                roi=roi,
                error_code=None,
            )
        return RetryOutcome(
            status="failed" if attempts >= retry_limit else "retrying",
            retry_attempts=attempts,
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
    except TimeoutError:
        return RetryOutcome(
            status="failed" if attempts >= retry_limit else "retrying",
            retry_attempts=attempts,
            error_code=ErrorCode.GPT_TIMEOUT.value,
        )
    except FileNotFoundError:
        return RetryOutcome(
            status="failed",
            retry_attempts=max(attempts, retry_limit),
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )
    except Exception:
        logger.exception("retry_diagnosis.process_failed file_id=%s", file_id)
        return RetryOutcome(
            status="failed" if attempts >= retry_limit else "retrying",
            retry_attempts=attempts,
            error_code=ErrorCode.SERVICE_UNAVAILABLE.value,
        )


def _fetch_pending_rows(batch_size: int) -> list[dict[str, Any]]:
    with db_module.SessionLocal() as db:
        rows = db.execute(
            text(
                "SELECT id, file_id, retry_attempts "
                "FROM photos "
                "WHERE deleted = FALSE AND status IN ('pending', 'retrying') "
                "ORDER BY ts DESC "
                "LIMIT :limit"
            ),
            {"limit": batch_size},
        ).mappings().all()
    return [dict(row) for row in rows]


def _save_outcome(photo_id: int, outcome: RetryOutcome) -> None:
    with db_module.SessionLocal() as db:
        db.execute(
            text(
                "UPDATE photos SET "
                "  status = :status, "
                "  retry_attempts = :retry_attempts, "
                "  crop = COALESCE(:crop, crop), "
                "  disease = COALESCE(:disease, disease), "
                "  confidence = COALESCE(:confidence, confidence), "
                "  roi = COALESCE(:roi, roi), "
                "  error_code = :error_code, "
                "  ts = :updated_at "
                "WHERE id = :photo_id"
            ),
            {
                "photo_id": photo_id,
                "status": outcome.status,
                "retry_attempts": outcome.retry_attempts,
                "crop": outcome.crop,
                "disease": outcome.disease,
                "confidence": outcome.confidence,
                "roi": outcome.roi,
                "error_code": outcome.error_code,
                "updated_at": datetime.now(timezone.utc),
            },
        )
        db.commit()


async def run_retry_cycle(
    *,
    batch_size: int,
    retry_limit: int,
    fetch_bytes: FetchBytesFn = download_photo,
    infer: InferFn = call_gpt_vision,
) -> RetryCycleStats:
    """Process one batch of pending/retrying photos."""
    stats = RetryCycleStats()
    rows = await asyncio.to_thread(_fetch_pending_rows, batch_size)
    stats.scanned = len(rows)

    for row in rows:
        photo_id = int(row["id"])
        outcome = await process_pending_photo(
            file_id=str(row["file_id"]),
            retry_attempts=int(row.get("retry_attempts") or 0),
            retry_limit=retry_limit,
            fetch_bytes=fetch_bytes,
            infer=infer,
        )
        await asyncio.to_thread(_save_outcome, photo_id, outcome)
        if outcome.status == "ok":
            stats.succeeded += 1
        elif outcome.status == "failed":
            stats.failed += 1
        else:
            stats.retried += 1

    if stats.scanned:
        logger.info(
            "retry_diagnosis.cycle scanned=%s succeeded=%s retried=%s failed=%s",
            stats.scanned,
            stats.succeeded,
            stats.retried,
            stats.failed,
        )
    return stats
