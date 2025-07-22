import json
import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request
from app.main import app, compute_signature, verify_hmac
from app.services.protocols import import_csv_to_db

client = TestClient(app)

HEADERS = {"X-API-Key": "test-api-key", "X-API-Ver": "v1"}


def test_openapi_schema():
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


def test_diagnose_json_success():
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


def test_diagnose_multipart_success():
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("leaf.jpg", b"x" * 10, "image/jpeg")},
    )
    assert resp.status_code == 200


def test_diagnose_missing_header():
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "test-api-key"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code in {400, 422}


def test_diagnose_invalid_key():
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "bad", "X-API-Ver": "v1"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 401


def test_diagnose_large_image():
    large = b"0" * (2 * 1024 * 1024 + 1)
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("big.jpg", large, "image/jpeg")},
    )
    assert resp.status_code == 400


def test_diagnose_json_returns_stub():
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


def test_diagnose_without_protocol():
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


def test_diagnose_json_bad_prompt():
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v2"},
    )
    assert resp.status_code == 400


def test_diagnose_json_missing_prompt():
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA=="},
    )
    assert resp.status_code == 400


def test_diagnose_invalid_base64():
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==@@", "prompt_id": "v1"},
    )
    assert resp.status_code == 400


def test_diagnose_multipart_missing_image():
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"file": ("x.txt", b"123", "text/plain")},
    )
    assert resp.status_code == 400


def test_quota_exceeded():
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


def test_limits_unauthorized():
    resp = client.get("/v1/limits", headers={"X-API-Key": "bad", "X-API-Ver": "v1"})
    assert resp.status_code in {401, 404}


def test_photos_success():
    resp = client.get("/v1/photos", headers=HEADERS)
    assert resp.status_code == 200


def test_photos_limit_zero():
    resp = client.get("/v1/photos?limit=0", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"] == []
    assert body["next_cursor"] is None


def test_photos_unauthorized():
    resp = client.get("/v1/photos", headers={"X-API-Key": "bad", "X-API-Ver": "v1"})
    assert resp.status_code in {401, 404}


def test_payment_webhook_success():
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
async def test_verify_hmac_returns_signature():
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


def test_payment_webhook_missing_signature():
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
    assert resp.status_code in {400, 401, 404}


def test_payment_webhook_bad_payload():
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


def test_partner_order_success():
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


def test_partner_order_missing_signature():
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
    assert resp.status_code in {400, 401, 404}


def test_partner_order_bad_payload():
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


def test_photos_table_has_meta():
    from app.db import SessionLocal
    import sqlalchemy as sa

    session = SessionLocal()
    insp = sa.inspect(session.bind)
    cols = {c['name'] for c in insp.get_columns('photos')}
    session.close()
    assert {'file_unique_id', 'width', 'height', 'file_size'} <= cols


def test_diagnose_json_with_protocol():
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


def test_diagnose_json_no_protocol_beta():
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
