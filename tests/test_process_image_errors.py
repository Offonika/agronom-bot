from __future__ import annotations
import json
import logging

import pytest

from app.controllers import photos


@pytest.mark.asyncio
async def test_process_image_timeout(monkeypatch, caplog):
    async def fake_upload_photo(user_id: int, data: bytes) -> str:
        return "key"

    async def fake_enforce_paywall(user_id: int):
        return None

    def fake_call_gpt_vision(
        key: str, _image_bytes: bytes | None = None, *, crop_hint: str | None = None
    ) -> dict:
        raise TimeoutError

    monkeypatch.setattr(photos, "upload_photo", fake_upload_photo)
    monkeypatch.setattr(photos, "_enforce_paywall", fake_enforce_paywall)
    monkeypatch.setattr(photos, "call_gpt_vision", fake_call_gpt_vision)

    with pytest.raises(photos._ProcessImageError) as exc, caplog.at_level(
        logging.ERROR
    ):
        await photos._process_image(b"data", 123)

    resp = exc.value.response
    assert resp.status_code == 502
    payload = json.loads(resp.body.decode())
    assert payload["code"] == "GPT_TIMEOUT"
    assert payload["message"]
    assert "GPT timeout" in caplog.text


@pytest.mark.asyncio
async def test_process_image_invalid_response(monkeypatch, caplog):
    async def fake_upload_photo(user_id: int, data: bytes) -> str:
        return "key"

    async def fake_enforce_paywall(user_id: int):
        return None

    def fake_call_gpt_vision(
        key: str, _image_bytes: bytes | None = None, *, crop_hint: str | None = None
    ) -> dict:
        raise ValueError("oops")

    monkeypatch.setattr(photos, "upload_photo", fake_upload_photo)
    monkeypatch.setattr(photos, "_enforce_paywall", fake_enforce_paywall)
    monkeypatch.setattr(photos, "call_gpt_vision", fake_call_gpt_vision)

    with pytest.raises(photos._ProcessImageError) as exc, caplog.at_level(
        logging.ERROR
    ):
        await photos._process_image(b"data", 123)

    resp = exc.value.response
    assert resp.status_code == 502
    payload = json.loads(resp.body.decode())
    assert payload["code"] == "SERVICE_UNAVAILABLE"
    assert payload["message"]
    assert "Invalid GPT response" in caplog.text