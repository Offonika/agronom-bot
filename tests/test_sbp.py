import asyncio
import time

import httpx
import pytest

from app.services.sbp import create_sbp_link


@pytest.mark.asyncio
async def test_create_sbp_link_handles_http_error(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SBP_API_URL", "https://example.test")

    async def fake_post(self, *args, **kwargs):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with caplog.at_level("ERROR"):
        url = await create_sbp_link("123", 100, "RUB")

    assert url == "https://sbp.example/pay/123"
    assert "boom" in caplog.text


@pytest.mark.asyncio
async def test_create_sbp_link_non_blocking(monkeypatch):
    """create_sbp_link should not block the event loop."""
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SBP_API_URL", "https://example.test")

    async def fake_post(self, *args, **kwargs):
        await asyncio.sleep(0.1)
        request = httpx.Request("POST", "https://example.test")
        return httpx.Response(200, json={"url": "https://sbp.example/pay/123"}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    start = time.perf_counter()
    await asyncio.gather(
        create_sbp_link("123", 100, "RUB"),
        asyncio.sleep(0.1),
    )
    duration = time.perf_counter() - start
    assert duration < 0.2
