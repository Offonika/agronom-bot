import hmac
import hashlib
import json
from datetime import datetime, timezone

from app.config import Settings
from app.dependencies import compute_signature
from app.db import SessionLocal
from app.models import User

# Reuse upload stubs from main API tests
from tests.test_api import stub_upload  # noqa: F401

settings = Settings()
HEADERS = {
    "X-API-Key": settings.api_key,
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}
HMAC_SECRET = settings.hmac_secret


def test_diag_metrics(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code in {200, 202}
    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    body = metrics.text
    assert "diag_requests_total" in body
    assert "diag_latency_seconds_bucket" in body


def test_autopay_metrics(client, monkeypatch):
    monkeypatch.setenv("SECURE_WEBHOOK", "1")
    with SessionLocal() as session:
        if not session.get(User, 1):
            session.add(User(id=1, tg_id=1))
            session.commit()

    payload = {
        "autopay_charge_id": "CHG-metric",
        "binding_id": "BND-metric",
        "user_id": 1,
        "amount": 100,
        "status": "fail",
        "charged_at": datetime.now(timezone.utc).isoformat(),
    }
    sig = compute_signature(HMAC_SECRET, payload)
    body = {**payload, "signature": sig}
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True)
    header_sig = hmac.new(HMAC_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()

    resp = client.post(
        "/v1/payments/sbp/autopay/webhook",
        headers=HEADERS | {"X-Sign": header_sig, "Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 200

    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    body = metrics.text
    assert "autopay_charge_seconds_bucket" in body
    assert "payment_fail_total" in body
