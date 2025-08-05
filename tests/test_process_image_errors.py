import logging

import pytest

from app.controllers import photos


@pytest.mark.asyncio
async def test_process_image_handles_generic_exception(monkeypatch, caplog):
    async def fake_upload_photo(user_id: int, data: bytes) -> str:
        return "key"

    async def fake_enforce_paywall(user_id: int):
        return None

    def fake_call_gpt_vision(key: str) -> dict:
        raise RuntimeError("boom")

    monkeypatch.setattr(photos, "upload_photo", fake_upload_photo)
    monkeypatch.setattr(photos, "_enforce_paywall", fake_enforce_paywall)
    monkeypatch.setattr(photos, "call_gpt_vision", fake_call_gpt_vision)

    with caplog.at_level(logging.ERROR):
        key, crop, disease, conf, roi = await photos._process_image(b"data", 123)

    assert key == "key"
    assert crop == ""
    assert disease == ""
    assert conf == 0.0
    assert roi == 0.0
    assert "GPT error" in caplog.text
