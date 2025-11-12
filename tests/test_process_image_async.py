from __future__ import annotations
import asyncio
import time

import pytest

from app.controllers import photos


@pytest.mark.asyncio
async def test_process_image_non_blocking(monkeypatch):
    async def fake_upload_photo(user_id: int, data: bytes) -> str:
        return "key"

    async def fake_enforce_paywall(user_id: int):
        return None

    def fake_call_gpt_vision(
        key: str, _image_bytes: bytes | None = None, *, crop_hint: str | None = None
    ) -> dict:
        time.sleep(0.2)
        return {
            "crop": "",
            "disease": "",
            "confidence": 0.0,
            "reasoning": [],
            "treatment_plan": None,
            "next_steps": None,
            "need_reshoot": False,
            "reshoot_tips": [],
        }

    monkeypatch.setattr(photos, "upload_photo", fake_upload_photo)
    monkeypatch.setattr(photos, "_enforce_paywall", fake_enforce_paywall)
    monkeypatch.setattr(photos, "call_gpt_vision", fake_call_gpt_vision)

    start = time.perf_counter()
    await asyncio.gather(
        photos._process_image(b"data", 123),
        asyncio.sleep(0.1),
    )
    duration = time.perf_counter() - start
    assert duration < 0.25