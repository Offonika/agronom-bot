import json
import pytest
from starlette.requests import Request
from app.main import compute_signature, verify_hmac
import os
from app.services.protocols import import_csv_to_db


@pytest.fixture(autouse=True)
def stub_upload(monkeypatch):
    """Prevent real S3 calls by stubbing upload_photo."""
    def _stub(user_id: int, data: bytes) -> str:
        return "1/stub.jpg"

    monkeypatch.setattr("app.services.storage.upload_photo", _stub)
    monkeypatch.setattr("app.main.upload_photo", _stub)
    # reset quota to avoid 429 errors between tests
    from app.db import SessionLocal
    from app.models import PhotoQuota
    from app.services.protocols import _cache_protocol

    with SessionLocal() as session:
        session.query(PhotoQuota).delete()
        session.commit()

    _cache_protocol.cache_clear()

HEADERS = {"X-API-Key": os.getenv("API_KEY", "test-api-key"), "X-API-Ver": "v1"}


def test_openapi_schema(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    data = resp.json()
    for path in [
        "/v1/ai/diagnose",
        "/v1/photos",
        "/v1/limits",
        "/v1/payments/sbp/webhook",
        "/v1/partner/orders",
    ]:
        assert path in data.get("paths", {})


def test_diagnose_json_success(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {
        "crop",
        "disease",
        "confidence",
        "protocol_status",
        "protocol",
    }


def test_diagnose_multipart_success(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("leaf.jpg", b"x" * 10, "image/jpeg")},
    )
    assert resp.status_code == 200


def test_diagnose_missing_header(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "test-api-key"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code in {400, 422}


def test_diagnose_invalid_key(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "bad", "X-API-Ver": "v1"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 401


def test_diagnose_large_image(client):
    large = b"0" * (2 * 1024 * 1024 + 1)
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("big.jpg", large, "image/jpeg")},
    )
    assert resp.status_code == 400


def test_diagnose_json_returns_stub(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "crop": "apple",
        "disease": "powdery_mildew",
        "confidence": 0.92,
        "protocol_status": None,
        "protocol": {
            "id": 1,
            "product": "Скор 250 ЭК",
            "dosage_value": 2.0,
            "dosage_unit": "ml_10l",
            "phi": 30,
        },
    }


def test_diagnose_without_protocol(client):
    from app.db import SessionLocal
    from app.models import Protocol

    session = SessionLocal()
    session.query(Protocol).delete()
    session.commit()
    session.close()

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["protocol"] is None
    assert data["protocol_status"] == "Бета"


def test_diagnose_json_bad_prompt(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v2"},
    )
    assert resp.status_code == 400


def test_diagnose_json_missing_prompt(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA=="},
    )
    assert resp.status_code == 400


def test_diagnose_invalid_base64(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==@@", "prompt_id": "v1"},
    )
    assert resp.status_code == 400


def test_diagnose_multipart_missing_image(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"file": ("x.txt", b"123", "text/plain")},
    )
    assert resp.status_code == 400


def test_quota_exceeded(client):
    limits = client.get("/v1/limits", headers=HEADERS)
    assert limits.status_code == 200
    data = limits.json()
    if data.get("limit_monthly_free") == data.get("used_this_month"):
        diag = client.post(
            "/v1/ai/diagnose",
            headers=HEADERS,
            json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
        )
        assert diag.status_code == 429


def test_limits_unauthorized(client):
    resp = client.get("/v1/limits", headers={"X-API-Key": "bad", "X-API-Ver": "v1"})
    assert resp.status_code in {401, 404}


def test_photos_success(client):
    resp = client.get("/v1/photos", headers=HEADERS)
    assert resp.status_code == 200


def test_photos_limit_zero(client):
    resp = client.get("/v1/photos?limit=0", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"] == []
    assert body["next_cursor"] is None


def test_photos_unauthorized(client):
    resp = client.get("/v1/photos", headers={"X-API-Key": "bad", "X-API-Ver": "v1"})
    assert resp.status_code in {401, 404}


def test_payment_webhook_success(client):
    payload = {
        "payment_id": "123",
        "amount": 100,
        "currency": "RUB",
        "status": "success",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    headers = {
        "X-API-Ver": "v1",
        "X-Sign": sig,
    }
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=headers,
        json=payload,
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_verify_hmac_returns_signature(client):
    payload = {"foo": "bar"}
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    body = json.dumps(payload).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http"}, receive)
    data, calculated, provided = await verify_hmac(request, sig)
    assert data == {"foo": "bar"}
    assert calculated == sig
    assert provided == sig


def test_payment_webhook_missing_signature(client):
    payload = {
        "payment_id": "123",
        "amount": 100,
        "currency": "RUB",
        "status": "success",
        "signature": "abc",
    }
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers={"X-API-Ver": "v1"},
        json=payload,
    )
    assert resp.status_code in {400, 401, 404, 422}


def test_payment_webhook_bad_payload(client):
    payload = {
        "payment_id": "123",
        "amount": 100,
        # missing currency
        "status": "success",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers={"X-API-Ver": "v1", "X-Sign": sig},
        json=payload,
    )
    assert resp.status_code in {400, 422}


def test_partner_order_success(client):
    payload = {
        "order_id": "o1",
        "user_tg_id": 1,
        "protocol_id": 2,
        "price_kopeks": 100,
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/partner/orders",
        headers={
            "X-API-Ver": "v1",
            "X-Sign": sig,
        },
        json=payload,
    )
    assert resp.status_code in {200, 202}


def test_partner_order_missing_signature(client):
    payload = {
        "order_id": "o1",
        "user_tg_id": 1,
        "protocol_id": 2,
        "price_kopeks": 100,
        "signature": "sig",
    }
    resp = client.post(
        "/v1/partner/orders",
        headers={"X-API-Ver": "v1"},
        json=payload,
    )
    assert resp.status_code in {400, 401, 404, 422}


def test_partner_order_bad_payload(client):
    payload = {
        "order_id": "o1",
        "user_tg_id": 1,
        # missing protocol_id
        "price_kopeks": 100,
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/partner/orders",
        headers={"X-API-Ver": "v1", "X-Sign": sig},
        json=payload,
    )
    assert resp.status_code in {400, 422}


def test_photos_table_has_meta(client):
    from app.db import SessionLocal
    import sqlalchemy as sa

    session = SessionLocal()
    insp = sa.inspect(session.bind)
    cols = {c['name'] for c in insp.get_columns('photos')}
    session.close()
    assert {'file_unique_id', 'width', 'height', 'file_size'} <= cols


def test_diagnose_json_with_protocol(client):
    import_csv_to_db()
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["protocol"] is not None
    assert data["protocol_status"] is None


def test_diagnose_json_no_protocol_beta(client):
    from app.db import SessionLocal
    from app.models import Protocol

    session = SessionLocal()
    session.query(Protocol).delete()
    session.commit()
    session.close()

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["protocol"] is None
    assert data["protocol_status"] == "Бета"


def test_free_monthly_limit_env(monkeypatch, client):
    monkeypatch.setattr("app.main.FREE_MONTHLY_LIMIT", 1)
    resp = client.get("/v1/limits", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["limit_monthly_free"] == 1

    # first request consumes the free quota
    first = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert first.status_code == 200

    # second request should be rejected
    second = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert second.status_code == 429
