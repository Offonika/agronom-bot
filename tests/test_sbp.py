from __future__ import annotations
import asyncio
import json
import time
from datetime import datetime, timezone, timedelta
import hmac
import hashlib
import jwt

import httpx
import pytest
from app.config import Settings
from sqlalchemy import text
from app.db import SessionLocal
from app.models import Event, Payment, User
from app.dependencies import compute_signature
from app.services.sbp import create_sbp_link, remove_sbp_customer, charge_rebill
from tests.utils.auth import build_auth_headers
from tests.utils.consent import ensure_autopay_consent, ensure_base_consents


settings = Settings()
HMAC_SECRET = settings.hmac_secret
JWT_SECRET = settings.jwt_secret

def _headers(
    method: str, path: str, *, user_id: int = 1, body: object | None = None
) -> dict[str, str]:
    return build_auth_headers(
        method, path, user_id=user_id, api_key=settings.api_key, body=body
    )

JWT_USER1 = jwt.encode({"user_id": 1}, JWT_SECRET, algorithm="HS256")
JWT_USER2 = jwt.encode({"user_id": 2}, JWT_SECRET, algorithm="HS256")
CSRF_TOKEN = "test-csrf"


@pytest.mark.asyncio
async def test_create_sbp_link_handles_http_error(monkeypatch, caplog):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SBP_API_URL", "https://example.test")

    async def fake_post(self, *args, **kwargs):
        raise httpx.HTTPError("boom")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with caplog.at_level("ERROR"):
        link = await create_sbp_link("123", 100, "RUB")

    assert link.url == "https://sbp.example/pay/123"
    assert link.binding_id is None
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
    link = await create_sbp_link("123", 100, "RUB", autopay=True)
    assert link.url.startswith("https://sbp.example/pay")
    assert link.binding_id == "BND-123"


@pytest.mark.asyncio
async def test_remove_sbp_customer_success(monkeypatch):
    monkeypatch.setenv("SBP_MODE", "tinkoff")
    monkeypatch.setenv("SBP_API_URL", "https://securepay.tinkoff.ru/v2")
    monkeypatch.setenv("TINKOFF_TERMINAL_KEY", "TERM-1")
    monkeypatch.setenv("TINKOFF_SECRET_KEY", "SECRET-1")

    calls: dict[str, object] = {}

    async def fake_post(self, url, **kwargs):
        calls["url"] = url
        calls["json"] = kwargs.get("json")
        request = httpx.Request("POST", url)
        return httpx.Response(200, json={"Success": True}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    result = await remove_sbp_customer("cust-1")

    assert result is True
    assert isinstance(calls.get("url"), str)
    assert str(calls["url"]).endswith("/RemoveCustomer")
    payload = calls.get("json")
    assert isinstance(payload, dict)
    assert payload.get("CustomerKey") == "cust-1"
    assert payload.get("TerminalKey") == "TERM-1"
    assert payload.get("Token")


@pytest.mark.asyncio
async def test_remove_sbp_customer_missing_creds(monkeypatch):
    monkeypatch.setenv("SBP_MODE", "tinkoff")
    monkeypatch.delenv("SBP_API_URL", raising=False)
    monkeypatch.delenv("TINKOFF_TERMINAL_KEY", raising=False)
    monkeypatch.delenv("TINKOFF_SECRET_KEY", raising=False)

    result = await remove_sbp_customer("cust-1")

    assert result is None


@pytest.mark.asyncio
async def test_remove_sbp_customer_failure(monkeypatch):
    monkeypatch.setenv("SBP_MODE", "tinkoff_test")
    monkeypatch.setenv("SBP_API_URL", "https://securepay.tinkoff.ru/v2")
    monkeypatch.setenv("TINKOFF_TERMINAL_KEY", "TERM-1")
    monkeypatch.setenv("TINKOFF_SECRET_KEY", "SECRET-1")

    async def fake_post(self, url, **kwargs):
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            json={"Success": False, "Message": "bad"},
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    result = await remove_sbp_customer("cust-1")

    assert result is False


@pytest.mark.asyncio
async def test_charge_rebill_success(monkeypatch):
    monkeypatch.setenv("SBP_MODE", "tinkoff")
    monkeypatch.setenv("SBP_API_URL", "https://securepay.tinkoff.ru/v2")
    monkeypatch.setenv("TINKOFF_TERMINAL_KEY", "TERM-1")
    monkeypatch.setenv("TINKOFF_SECRET_KEY", "SECRET-1")

    async def fake_post(self, url, **kwargs):
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            json={"Success": True, "PaymentId": "p1", "Status": "CONFIRMED"},
            request=request,
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    payment_id, status = await charge_rebill(
        order_id="ORD-1",
        amount=19900,
        rebill_id="R-1",
        customer_key="1",
    )

    assert payment_id == "p1"
    assert status == "CONFIRMED"


@pytest.mark.asyncio
async def test_charge_rebill_missing_creds(monkeypatch):
    monkeypatch.setenv("SBP_MODE", "tinkoff")
    monkeypatch.delenv("SBP_API_URL", raising=False)
    monkeypatch.delenv("TINKOFF_TERMINAL_KEY", raising=False)
    monkeypatch.delenv("TINKOFF_SECRET_KEY", raising=False)

    payment_id, status = await charge_rebill(
        order_id="ORD-1",
        amount=19900,
        rebill_id="R-1",
    )

    assert payment_id is None
    assert status is None


def _ensure_user(session):
    user = session.get(User, 1)
    if not user:
        user = User(id=1, tg_id=1, autopay_enabled=True)
        session.add(user)
    else:
        user.autopay_enabled = True
    session.commit()


def _set_csrf_cookie(client):
    client.cookies.set("csrf_token", CSRF_TOKEN)


def test_create_payment_with_autopay(client):
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
            session.commit()
        ensure_base_consents(session, 1)
        ensure_autopay_consent(session, 1)
    resp = client.post(
        "/v1/payments/create",
        headers=_headers(
            "POST",
            "/v1/payments/create",
            body={"user_id": 1, "plan": "pro", "months": 1, "autopay": True},
        ),
        json={"user_id": 1, "plan": "pro", "months": 1, "autopay": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("autopay_binding_id") is not None
    with SessionLocal() as session:
        payment = session.query(Payment).filter_by(external_id=data["payment_id"]).first()
        assert payment.autopay is True
        assert payment.autopay_binding_id == data["autopay_binding_id"]


def test_create_payment_requires_consents(client):
    with SessionLocal() as session:
        if not session.get(User, 2):
            session.add(User(id=2, tg_id=2))
            session.commit()
        session.execute(
            text("DELETE FROM user_consents WHERE user_id = :uid"),
            {"uid": 2},
        )
        session.execute(
            text("DELETE FROM consent_events WHERE user_id = :uid"),
            {"uid": 2},
        )
        session.commit()
    payload = {"user_id": 2, "plan": "pro", "months": 1}
    resp = client.post(
        "/v1/payments/create",
        headers=_headers("POST", "/v1/payments/create", user_id=2, body=payload),
        json=payload,
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["message"] == "CONSENT_REQUIRED"


def test_create_payment_idempotency(client):
    with SessionLocal() as session:
        if not session.get(User, 3):
            session.add(User(id=3, tg_id=3))
            session.commit()
        ensure_base_consents(session, 3)
    payload = {"user_id": 3, "plan": "pro", "months": 1}
    headers = _headers("POST", "/v1/payments/create", user_id=3, body=payload) | {
        "Idempotency-Key": "idem-3",
    }
    headers_second = _headers(
        "POST",
        "/v1/payments/create",
        user_id=3,
        body=payload,
    ) | {"Idempotency-Key": "idem-3"}
    first = client.post("/v1/payments/create", headers=headers, json=payload)
    second = client.post("/v1/payments/create", headers=headers_second, json=payload)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["payment_id"] == second.json()["payment_id"]
    assert first.json()["url"] == second.json()["url"]
    with SessionLocal() as session:
        rows = (
            session.query(Payment)
            .filter_by(user_id=3, idempotency_key="idem-3")
            .all()
        )
        assert len(rows) == 1


def test_autopay_webhook_success(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
        ensure_autopay_consent(session, 1)
        session.commit()

    payload = {
        "autopay_charge_id": "CHG-1",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 19900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": header_sig, "Content-Type": "application/json"},
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
        assert user.autopay_rebill_id == "BND-1"
        assert user.pro_expires_at is not None
        user.pro_expires_at = None
        user.autopay_enabled = False
        user.autopay_rebill_id = None
        session.commit()


def test_autopay_webhook_logs_wrong_amount(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    payload = {
        "autopay_charge_id": "CHG-wrong",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": settings.pro_month_price_cents + 100,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 200
    with SessionLocal() as session:
        payment = (
            session.query(Payment)
            .filter_by(autopay_charge_id="CHG-wrong")
            .first()
        )
        assert payment is not None
        assert payment.amount == payload["amount"]
        mismatch_event = (
            session.query(Event)
            .filter_by(user_id=payload["user_id"], event="autopay_amount_mismatch")
            .order_by(Event.id.desc())
            .first()
        )
        assert mismatch_event is not None


def test_autopay_webhook_binding_mismatch(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
        if not session.get(User, 2):
            session.add(User(id=2, tg_id=2))
        session.add(
            Payment(
                user_id=2,
                amount=19900,
                currency="RUB",
                provider="sbp",
                external_id="INIT-BIND-2",
                prolong_months=1,
                status="success",
                autopay=True,
                autopay_binding_id="BND-2",
            )
        )
        session.commit()

    payload = {
        "autopay_charge_id": "CHG-mismatch",
        "binding_id": "BND-2",
        "user_id": 1,
        "amount": 19900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 403


def test_autopay_webhook_ignores_after_success(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    with SessionLocal() as session:
        user = session.get(User, 99)
        if not user:
            user = User(id=99, tg_id=99)
            session.add(user)
        user.autopay_rebill_id = "BND-dup"
        session.add(
            Payment(
                user_id=99,
                amount=19900,
                currency="RUB",
                provider="sbp",
                external_id="CHG-dup",
                prolong_months=1,
                status="success",
                autopay=True,
                autopay_binding_id="BND-dup",
                autopay_charge_id="CHG-dup",
            )
        )
        session.commit()

    payload = {
        "autopay_charge_id": "CHG-dup",
        "binding_id": "BND-dup",
        "user_id": 99,
        "amount": 19900,
        "status": "cancel",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", user_id=99, body=body)
        | {"X-Sign": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 200
    with SessionLocal() as session:
        payment = (
            session.query(Payment)
            .filter_by(autopay_charge_id="CHG-dup")
            .first()
        )
        assert payment is not None
        assert payment.status == "success"


def test_autopay_webhook_bad_signature(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    payload = {
        "autopay_charge_id": "CHG-2",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 19900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    bad_header = "bad" + hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[3:]

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": bad_header, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 403


def test_autopay_webhook_insecure_skips_signature(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "false")
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
            session.commit()

    payload = {
        "autopay_charge_id": "CHG-2a",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 19900,
        "status": "success",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": "bad", "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 200
    with SessionLocal() as session:
        payment = (
            session.query(Payment)
            .filter_by(autopay_charge_id="CHG-2a")
            .first()
        )
        assert payment is not None
        # cleanup
        session.delete(payment)
        user = session.get(User, 1)
        if user:
            user.pro_expires_at = None
            user.autopay_enabled = False
            session.add(user)
        session.commit()


def test_autopay_webhook_invalid_status(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    payload = {
        "autopay_charge_id": "CHG-3",
        "binding_id": "BND-1",
        "user_id": 1,
        "amount": 19900,
        "status": "unknown",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=_headers("POST", "/v1/payments/sbp/autopay/webhook", body=body)
        | {"X-Sign": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 400


def test_autopay_cancel_success(client):
    with SessionLocal() as session:
        _ensure_user(session)
    headers = _headers(
        "POST",
        "/v1/payments/sbp/autopay/cancel",
        body={"user_id": 1},
    ) | {
        "Authorization": f"Bearer {JWT_USER1}",
        "X-CSRF-Token": CSRF_TOKEN,
    }
    _set_csrf_cookie(client)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 204
    with SessionLocal() as session:
        user = session.get(User, 1)
        assert user and user.autopay_enabled in (0, False)


def test_autopay_cancel_user_mismatch(client):
    with SessionLocal() as session:
        _ensure_user(session)
    headers = _headers(
        "POST",
        "/v1/payments/sbp/autopay/cancel",
        user_id=2,
        body={"user_id": 1},
    ) | {
        "Authorization": f"Bearer {JWT_USER2}",
        "X-CSRF-Token": CSRF_TOKEN,
    }
    _set_csrf_cookie(client)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 401
    with SessionLocal() as session:
        user = session.get(User, 1)
        assert user and user.autopay_enabled in (1, True)


def test_autopay_cancel_csrf_fail(client):
    with SessionLocal() as session:
        _ensure_user(session)
    headers = _headers(
        "POST",
        "/v1/payments/sbp/autopay/cancel",
        body={"user_id": 1},
    ) | {
        "Authorization": f"Bearer {JWT_USER1}",
        "X-CSRF-Token": "bad",  # mismatch token
    }
    _set_csrf_cookie(client)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 403


def test_autopay_cancel_jwt_fail(client):
    with SessionLocal() as session:
        _ensure_user(session)
    headers = _headers(
        "POST",
        "/v1/payments/sbp/autopay/cancel",
        body={"user_id": 1},
    ) | {
        "Authorization": f"Bearer {JWT_USER2}",  # wrong user in token
        "X-CSRF-Token": CSRF_TOKEN,
    }
    _set_csrf_cookie(client)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 401


def test_autopay_cancel_jwt_expired(client):
    with SessionLocal() as session:
        _ensure_user(session)
    expired = jwt.encode(
        {
            "user_id": 1,
            "exp": datetime.now(timezone.utc) - timedelta(seconds=1),
        },
        JWT_SECRET,
        algorithm="HS256",
    )
    headers = _headers(
        "POST",
        "/v1/payments/sbp/autopay/cancel",
        body={"user_id": 1},
    ) | {
        "Authorization": f"Bearer {expired}",
        "X-CSRF-Token": CSRF_TOKEN,
    }
    _set_csrf_cookie(client)
    resp = client.post(
        "/v1/payments/sbp/autopay/cancel",
        headers=headers,
        json={"user_id": 1},
    )
    assert resp.status_code == 401


@pytest.mark.parametrize(
    "endpoint",
    ["/v1/payments/sbp/webhook", "/v1/payments/sbp/autopay/webhook"],
)
@pytest.mark.parametrize("payload", ["[]", "123"])
def test_webhook_rejects_non_object_json(client, endpoint, payload):
    body_payload = json.loads(payload)
    resp = client.post(
        endpoint,
        headers=_headers("POST", endpoint, body=body_payload)
        | {"Content-Type": "application/json"},
        content=payload,
    )
    assert resp.status_code == 400
