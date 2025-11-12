from __future__ import annotations
import os

import pytest
from redis.exceptions import RedisError
from app import dependencies

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}


def test_rate_limit_ip(client):
    headers = HEADERS.copy()
    headers["X-Forwarded-For"] = "1.1.1.1"
    for _ in range(30):
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


def test_rate_limit_user(client):
    headers = HEADERS.copy()
    for i in range(120):
        headers["X-Forwarded-For"] = f"10.0.0.{i//30}"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers["X-Forwarded-For"] = "10.0.0.4"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


def test_rate_limit_redis_unavailable(client, monkeypatch):
    class _RedisFail:
        def pipeline(self):
            raise RedisError

    monkeypatch.setattr(dependencies, "redis_client", _RedisFail())
    resp = client.get("/v1/photos", headers=HEADERS)
    assert resp.status_code == 503


def test_rate_limit_untrusted_proxy(client, monkeypatch):
    headers = HEADERS.copy()
    monkeypatch.setattr(dependencies.settings, "trusted_proxies", ["127.0.0.1"])
    for i in range(30):
        headers["X-Forwarded-For"] = f"1.1.1.{i}"
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    headers["X-Forwarded-For"] = "1.1.1.30"
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429


@pytest.mark.parametrize("xff", ["", "   "])
def test_rate_limit_empty_x_forwarded_for(client, xff):
    headers = HEADERS.copy()
    headers["X-Forwarded-For"] = xff
    for _ in range(30):
        resp = client.get("/v1/photos", headers=headers)
        assert resp.status_code == 200
    resp = client.get("/v1/photos", headers=headers)
    assert resp.status_code == 429