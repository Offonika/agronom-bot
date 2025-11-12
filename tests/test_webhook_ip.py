from __future__ import annotations
import logging
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app import db as db_module
from app.config import Settings
from app.dependencies import compute_signature
from app.main import app
from app.models import Payment


settings = Settings()


def _auth_headers():
    return {
        "X-API-Key": settings.api_key,
        "X-API-Ver": "v1",
        "X-User-ID": "1",
    }


def test_payments_webhook_forbidden_ip(caplog):
    bad_ip = "10.0.0.1"
    with TestClient(app, client=(bad_ip, 5000)) as client, caplog.at_level(
        logging.WARNING
    ):
        resp = client.post(
            "/v1/payments/sbp/webhook", headers=_auth_headers(), json={}
        )
    assert resp.status_code == 403
    assert f"forbidden ip {bad_ip}" in caplog.text


def test_payments_webhook_allowed_ip(apply_migrations):
    allowed_ip = settings.tinkoff_ips[0]
    external_id = "ext123"
    with db_module.SessionLocal() as db:
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id=external_id,
            prolong_months=1,
            status="pending",
        )
        db.add(payment)
        db.commit()

    payload = {
        "external_id": external_id,
        "status": "success",
        "paid_at": datetime.now(timezone.utc).isoformat(),
    }
    payload["signature"] = compute_signature(settings.hmac_secret, payload.copy())
    with TestClient(app, client=(allowed_ip, 5000)) as client:
        resp = client.post(
            "/v1/payments/sbp/webhook", headers=_auth_headers(), json=payload
        )
    assert resp.status_code == 200


def test_payments_webhook_x_forwarded_for(apply_migrations):
    allowed_ip = settings.tinkoff_ips[0]
    bad_ip = "10.0.0.1"
    external_id = "ext123fwd"
    with db_module.SessionLocal() as db:
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id=external_id,
            prolong_months=1,
            status="pending",
        )
        db.add(payment)
        db.commit()

    payload = {
        "external_id": external_id,
        "status": "success",
        "paid_at": datetime.now(timezone.utc).isoformat(),
    }
    payload["signature"] = compute_signature(settings.hmac_secret, payload.copy())
    headers = _auth_headers()
    headers["X-Forwarded-For"] = f"{allowed_ip}, {bad_ip}"
    with TestClient(app, client=(bad_ip, 5000)) as client:
        resp = client.post(
            "/v1/payments/sbp/webhook", headers=headers, json=payload
        )
    assert resp.status_code == 200


def test_partner_orders_forbidden_ip(caplog):
    bad_ip = "10.0.0.1"
    headers = {"X-Sign": "bad"}
    with TestClient(app, client=(bad_ip, 5000)) as client, caplog.at_level(
        logging.WARNING
    ):
        resp = client.post("/v1/partner/orders", headers=headers, json={})
    assert resp.status_code == 403
    assert f"forbidden ip {bad_ip}" in caplog.text


def test_partner_orders_allowed_ip():
    allowed_ip = settings.partner_ips[0]
    payload = {
        "order_id": "ord1",
        "user_tg_id": 1,
        "protocol_id": 1,
        "price_kopeks": 1000,
    }
    sign = compute_signature(settings.hmac_secret_partner, payload.copy())
    payload["signature"] = sign
    headers = {"X-Sign": sign}
    with TestClient(app, client=(allowed_ip, 5000)) as client:
        resp = client.post("/v1/partner/orders", headers=headers, json=payload)
    assert resp.status_code == 202


def test_partner_orders_x_forwarded_for():
    allowed_ip = settings.partner_ips[0]
    bad_ip = "10.0.0.1"
    payload = {
        "order_id": "ord2",
        "user_tg_id": 1,
        "protocol_id": 1,
        "price_kopeks": 1000,
    }
    sign = compute_signature(settings.hmac_secret_partner, payload.copy())
    payload["signature"] = sign
    headers = {"X-Sign": sign, "X-Forwarded-For": f"{allowed_ip}, {bad_ip}"}
    with TestClient(app, client=(bad_ip, 5000)) as client:
        resp = client.post("/v1/partner/orders", headers=headers, json=payload)
    assert resp.status_code == 202


def test_partner_orders_rate_limit():
    allowed_ip = settings.partner_ips[0]
    payload = {
        "order_id": "ord1",
        "user_tg_id": 1,
        "protocol_id": 1,
        "price_kopeks": 1000,
    }
    sign = compute_signature(settings.hmac_secret_partner, payload.copy())
    payload["signature"] = sign
    headers = {"X-Sign": sign}
    with TestClient(app, client=(allowed_ip, 5000)) as client:
        for _ in range(30):
            resp = client.post("/v1/partner/orders", headers=headers, json=payload)
            assert resp.status_code in {200, 202}
        resp = client.post("/v1/partner/orders", headers=headers, json=payload)
        assert resp.status_code == 429
