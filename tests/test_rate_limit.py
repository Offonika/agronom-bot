from __future__ import annotations
import os

import pytest
from redis.exceptions import RedisError
from app import dependencies
from tests.utils.auth import build_auth_headers

API_KEY = os.getenv("API_KEY", "test-api-key")


def _headers() -> dict[str, str]:
    return build_auth_headers("GET", "/v1/photos", user_id=1, api_key=API_KEY)


def test_rate_limit_ip(client):
    for _ in range(30):
        headers = _headers()
        headers["X-Forwarded-For"] = "1.1.1.1"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers = _headers()
    headers["X-Forwarded-For"] = "1.1.1.1"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


def test_rate_limit_user(client):
    for i in range(120):
        headers = _headers()
        headers["X-Forwarded-For"] = f"10.0.0.{i//30}"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers = _headers()
    headers["X-Forwarded-For"] = "10.0.0.4"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


def test_rate_limit_redis_unavailable(client, monkeypatch):
    class _RedisFail:
        def pipeline(self):
            raise RedisError
        async def set(self, *_args, **_kwargs):
            raise RedisError

    monkeypatch.setattr(dependencies, "redis_client", _RedisFail())
    resp = client.get("/v1/photos", headers=_headers())
    assert resp.status_code == 503


def test_rate_limit_untrusted_proxy(client, monkeypatch):
    monkeypatch.setattr(dependencies.settings, "trusted_proxies", ["127.0.0.1"])
    for i in range(30):
        headers = _headers()
        headers["X-Forwarded-For"] = f"1.1.1.{i}"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers = _headers()
    headers["X-Forwarded-For"] = "1.1.1.30"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


@pytest.mark.parametrize("xff", ["", "   "])
def test_rate_limit_empty_x_forwarded_for(client, xff):
    for _ in range(30):
        headers = _headers()
        headers["X-Forwarded-For"] = xff
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers = _headers()
    headers["X-Forwarded-For"] = xff
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429
