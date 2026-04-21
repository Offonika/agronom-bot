from __future__ import annotations

import pytest

from app.models import ErrorCode
from app.services.retry_diagnosis import process_pending_photo


@pytest.mark.asyncio
async def test_process_pending_photo_success() -> None:
    async def fake_fetch(_key: str) -> bytes:
        return b"img"

    def fake_infer(_key: str, _image: bytes | None):
        return {"crop": "cucumber", "disease": "mildew", "confidence": 0.82}

    result = await process_pending_photo(
        file_id="1/test.jpg",
        retry_attempts=0,
        retry_limit=3,
        fetch_bytes=fake_fetch,
        infer=fake_infer,
    )

    assert result.status == "ok"
    assert result.retry_attempts == 1
    assert result.crop == "cucumber"
    assert result.disease == "mildew"
    assert result.error_code is None


@pytest.mark.asyncio
async def test_process_pending_photo_missing_fields_goes_retrying() -> None:
    async def fake_fetch(_key: str) -> bytes:
        return b"img"

    def fake_infer(_key: str, _image: bytes | None):
        return {"crop": "cucumber", "disease": "", "confidence": 0.22}

    result = await process_pending_photo(
        file_id="1/test.jpg",
        retry_attempts=1,
        retry_limit=3,
        fetch_bytes=fake_fetch,
        infer=fake_infer,
    )

    assert result.status == "retrying"
    assert result.retry_attempts == 2
    assert result.error_code == ErrorCode.SERVICE_UNAVAILABLE.value


@pytest.mark.asyncio
async def test_process_pending_photo_timeout_sets_gpt_timeout_error() -> None:
    async def fake_fetch(_key: str) -> bytes:
        return b"img"

    def fake_infer(_key: str, _image: bytes | None):
        raise TimeoutError("timeout")

    result = await process_pending_photo(
        file_id="1/test.jpg",
        retry_attempts=0,
        retry_limit=3,
        fetch_bytes=fake_fetch,
        infer=fake_infer,
    )

    assert result.status == "retrying"
    assert result.retry_attempts == 1
    assert result.error_code == ErrorCode.GPT_TIMEOUT.value


@pytest.mark.asyncio
async def test_process_pending_photo_respects_retry_limit() -> None:
    async def fake_fetch(_key: str) -> bytes:
        raise AssertionError("fetch must not be called when retry limit reached")

    result = await process_pending_photo(
        file_id="1/test.jpg",
        retry_attempts=3,
        retry_limit=3,
        fetch_bytes=fake_fetch,
    )

    assert result.status == "failed"
    assert result.retry_attempts == 3
    assert result.error_code == ErrorCode.SERVICE_UNAVAILABLE.value


@pytest.mark.asyncio
async def test_process_pending_photo_marks_telegram_file_id_as_failed() -> None:
    async def fake_fetch(_key: str) -> bytes:
        raise AssertionError("fetch must not run for non-S3 file_id")

    result = await process_pending_photo(
        file_id="AgACAgIAAxkBAA...",
        retry_attempts=0,
        retry_limit=3,
        fetch_bytes=fake_fetch,
    )

    assert result.status == "failed"
    assert result.retry_attempts == 3
    assert result.error_code == ErrorCode.SERVICE_UNAVAILABLE.value
