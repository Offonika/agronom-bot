import asyncio
import json
import time
from datetime import datetime, timezone
import hmac
import hashlib

import httpx
import pytest
from app.config import Settings
from app.db import SessionLocal
from app.models import Payment, User
from app.dependencies import compute_signature
from app.services.sbp import create_sbp_link


settings = Settings()
HMAC_SECRET = settings.hmac_secret

HEADERS = {
    "X-API-Key": settings.api_key,
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}


@pytest.mark.asyncio
async def test_create_sbp_link_handles_http_error(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SBP_API_URL", "https://example.test")

    async def fake_post(self, *args, **kwargs):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with caplog.at_level("ERROR"):
        url, binding = await create_sbp_link("123", 100, "RUB")

    assert url == "https://sbp.example/pay/123"
    assert binding is None
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


@pytest.mark.asyncio
async def test_create_sbp_link_autopay_returns_binding(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    url, binding = await create_sbp_link("123", 100, "RUB", autopay=True)
    assert url.startswith("https://sandbox/pay")
    assert binding == "BND-123"


def _ensure_user(session):
    user = session.get(User, 1)
    if not user:
        user = User(id=1, tg_id=1, autopay_enabled=True)
        session.add(user)
    else:
        user.autopay_enabled = True
    session.commit()


def test_create_payment_with_autopay(client):
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
            session.commit()
    resp = client.post(
        "/v1/payments/create",
        headers=HEADERS,
        json={"user_id": 1, "plan": "pro", "months": 1, "autopay": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("autopay_binding_id") is not None
    with SessionLocal() as session:
        payment = session.query(Payment).filter_by(external_id=data["payment_id"]).first()
        assert payment.autopay is True
        assert payment.autopay_binding_id == data["autopay_binding_id"]


def test_autopay_webhook_success(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
            session.commit()

    payload = {
        "autopay_charge_id": "CHG-1",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 34900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=HEADERS | {"X-Signature": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 200
    with SessionLocal() as session:
        payment = (
            session.query(Payment)
            .filter_by(autopay_charge_id="CHG-1")
            .first()
        )
        assert payment is not None
        assert payment.status == "success"
        assert payment.autopay is True
        assert payment.autopay_binding_id == "BND-1"
        assert payment.autopay_charge_id == "CHG-1"
        user = session.get(User, 1)
        assert user and user.autopay_enabled is True
        assert user.pro_expires_at is not None
        user.pro_expires_at = None
        user.autopay_enabled = False
        session.commit()


def test_autopay_webhook_bad_signature(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    payload = {
        "autopay_charge_id": "CHG-2",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 34900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    bad_header = "bad" + hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[3:]

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=HEADERS | {"X-Signature": bad_header, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 403


def test_autopay_webhook_invalid_status(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    payload = {
        "autopay_charge_id": "CHG-3",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 34900,
        "status": "unknown",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=HEADERS | {"X-Signature": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 400


def test_autopay_cancel_success(client):
    with SessionLocal() as session:
        _ensure_user(session)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=HEADERS,
        json={"user_id": 1},
    )
    assert resp.status_code == 204
    with SessionLocal() as session:
        user = session.get(User, 1)
        assert user and user.autopay_enabled in (0, False)


def test_autopay_cancel_user_mismatch(client):
    with SessionLocal() as session:
        _ensure_user(session)
    headers = HEADERS | {"X-User-ID": "2"}
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 401
    with SessionLocal() as session:
        user = session.get(User, 1)
        assert user and user.autopay_enabled in (1, True)
