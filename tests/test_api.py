import json
import base64
import os
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from sqlalchemy import text
from app.main import compute_signature, verify_hmac
from app.services.protocols import import_csv_to_db


@pytest.fixture(autouse=True)
def stub_upload(monkeypatch):
    """Prevent real S3 calls by stubbing upload_photo."""
    def _stub(user_id: int, data: bytes) -> str:
        return "1/stub.jpg"

    monkeypatch.setattr("app.services.storage.upload_photo", _stub)
    monkeypatch.setattr("app.main.upload_photo", _stub)
    # reset usage to avoid 402 errors between tests
    from app.db import SessionLocal
    from app.models import PhotoUsage
    from app.services.protocols import _cache_protocol

    with SessionLocal() as session:
        session.query(PhotoUsage).delete()
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
        "/v1/payments/create",
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
    assert resp.json()["detail"]["code"] == "UNAUTHORIZED"


def test_diagnose_large_image(client):
    large = b"0" * (2 * 1024 * 1024 + 1)
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("big.jpg", large, "image/jpeg")},
    )
    assert resp.status_code == 400


def test_diagnose_large_base64(client):
    large_bytes = b"0" * (2 * 1024 * 1024 + 1)
    encoded = base64.b64encode(large_bytes).decode()
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": encoded, "prompt_id": "v1"},
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


def test_diagnose_gpt_timeout(monkeypatch, client):
    def _fail(_key: str):
        raise TimeoutError("timeout")

    monkeypatch.setattr("app.main.call_gpt_vision_stub", _fail)

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 502
    data = resp.json()
    assert data["code"] == "GPT_TIMEOUT"

    from app.db import SessionLocal
    from app.models import Photo

    with SessionLocal() as session:
        photo = session.query(Photo).order_by(Photo.id.desc()).first()
        assert photo.status == "pending"


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
        assert diag.status_code == 402


def test_limits_unauthorized(client):
    resp = client.get("/v1/limits", headers={"X-API-Key": "bad", "X-API-Ver": "v1"})
    assert resp.status_code in {401, 404}
    if resp.status_code == 401:
        assert resp.json()["detail"]["code"] == "UNAUTHORIZED"


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
    if resp.status_code == 401:
        assert resp.json()["detail"]["code"] == "UNAUTHORIZED"


def test_photo_status_pending(client):
    from app.db import SessionLocal
    from app.models import Photo

    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="test.jpg", status="pending")
        session.add(photo)
        session.commit()
        pid = photo.id

    resp = client.get(f"/v1/photos/{pid}", headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "pending"
    assert "updated_at" in data


def test_photo_status_completed(client):
    from app.db import SessionLocal
    from app.models import Photo
    from app.services.protocols import import_csv_to_db

    import_csv_to_db()

    with SessionLocal() as session:
        photo = Photo(
            user_id=1,
            file_id="test.jpg",
            status="ok",
            crop="apple",
            disease="powdery_mildew",
        )
        session.add(photo)
        session.commit()
        pid = photo.id

    resp = client.get(f"/v1/photos/{pid}", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["crop"] == "apple"
    assert body["disease"] == "powdery_mildew"
    assert body["protocol"] is not None


def test_photo_status_failed(client):
    """Photo with failed status returns minimal fields."""
    from app.db import SessionLocal
    from app.models import Photo

    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="test.jpg", status="failed")
        session.add(photo)
        session.commit()
        pid = photo.id

    resp = client.get(f"/v1/photos/{pid}", headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "failed"
    assert "updated_at" in data


def test_create_payment(client):
    payload = {"user_id": 1, "plan": "pro", "months": 1}
    resp = client.post("/v1/payments/create", headers=HEADERS, json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["url"].startswith("https://")
    assert data["payment_id"]

    from app.db import SessionLocal
    from app.models import Payment, Event

    with SessionLocal() as session:
        row = session.query(Payment).filter_by(external_id=data["payment_id"]).first()
        assert row is not None
        assert row.status == "pending"
        event = session.query(Event).filter_by(user_id=1).order_by(Event.id.desc()).first()
        assert event.event == "payment_created"


def test_payment_webhook_success(client):
    from app.db import SessionLocal
    from app.models import Payment, Event

    with SessionLocal() as session:
        session.execute(
            text("INSERT OR IGNORE INTO users (id, tg_id) VALUES (1, 1)")
        )
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id="p1",
            prolong_months=1,
            status="pending",
        )
        session.add(payment)
        session.commit()

    payload = {
        "external_id": "p1",
        "status": "success",
        "paid_at": "2024-01-01T00:00:00Z",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    headers = HEADERS | {"X-Signature": sig}
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=headers,
        json=payload,
    )
    assert resp.status_code == 200

    with SessionLocal() as session:
        row = session.query(Payment).filter_by(external_id="p1").first()
        assert row.status == "success"
        events = (
            session.query(Event)
            .filter_by(user_id=1)
            .order_by(Event.id.desc())
            .limit(2)
            .all()
        )
        names = {e.event for e in events}
        assert {"payment_success", "pro_activated"}.issubset(names)


def test_payment_webhook_updates_pro_expiration(client):
    """PRO expires_at is set after successful webhook."""
    from app.db import SessionLocal
    from app.models import Payment

    paid_at = datetime(2024, 1, 1, tzinfo=timezone.utc)

    with SessionLocal() as session:
        session.execute(text("INSERT OR IGNORE INTO users (id, tg_id) VALUES (1, 1)"))
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id="p3",
            prolong_months=1,
            status="pending",
        )
        session.add(payment)
        session.commit()

    payload = {
        "external_id": "p3",
        "status": "success",
        "paid_at": paid_at.isoformat().replace("+00:00", "Z"),
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=HEADERS | {"X-Signature": sig},
        json=payload,
    )
    assert resp.status_code == 200

    with SessionLocal() as session:
        expires = session.execute(
            text("SELECT pro_expires_at FROM users WHERE id=1")
        ).scalar()
        assert expires is not None
        if isinstance(expires, str):
            expires = datetime.fromisoformat(expires)
        assert expires > paid_at


def test_payment_webhook_cancel(client):
    """Webhook with status=cancel records failure."""
    from app.db import SessionLocal
    from app.models import Payment, Event

    with SessionLocal() as session:
        session.execute(text("INSERT OR IGNORE INTO users (id, tg_id) VALUES (1, 1)"))
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id="p4",
            prolong_months=1,
            status="pending",
        )
        session.add(payment)
        session.commit()

    payload = {
        "external_id": "p4",
        "status": "cancel",
        "paid_at": "2024-01-01T00:00:00Z",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=HEADERS | {"X-Signature": sig},
        json=payload,
    )
    assert resp.status_code == 200

    with SessionLocal() as session:
        row = session.query(Payment).filter_by(external_id="p4").first()
        assert row.status == "cancel"
        event = session.query(Event).filter_by(user_id=1).order_by(Event.id.desc()).first()
        assert event.event == "payment_fail"


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


@pytest.mark.asyncio
async def test_verify_hmac_bad_header_signature(client):
    payload = {"foo": "bar"}
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    body = json.dumps(payload).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http"}, receive)
    with pytest.raises(HTTPException) as exc:
        await verify_hmac(request, "bad")
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_verify_hmac_bad_payload_signature(client):
    payload = {"foo": "bar"}
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = "invalid"
    body = json.dumps(payload).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http"}, receive)
    with pytest.raises(HTTPException) as exc:
        await verify_hmac(request, sig)
    assert exc.value.status_code == 401


def test_payment_webhook_missing_signature(client):
    payload = {
        "external_id": "1",
        "status": "success",
        "paid_at": "2024-01-01T00:00:00Z",
        "signature": "abc",
    }
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=HEADERS,
        json=payload,
    )
    assert resp.status_code in {400, 401, 404, 422}


def test_payment_webhook_bad_payload(client):
    payload = {
        "external_id": "123",
        # missing status
        "paid_at": "2024-01-01T00:00:00Z",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=HEADERS | {"X-Signature": sig},
        json=payload,
    )
    assert resp.status_code in {400, 422}


def test_payment_webhook_bad_signature_returns_403(client, monkeypatch):
    from app.db import SessionLocal
    from app.models import Payment

    monkeypatch.setenv("SECURE_WEBHOOK", "1")

    with SessionLocal() as session:
        session.execute(text("INSERT OR IGNORE INTO users (id, tg_id) VALUES (1, 1)"))
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id="p2",
            prolong_months=1,
            status="pending",
        )
        session.add(payment)
        session.commit()

    payload = {
        "external_id": "p2",
        "status": "success",
        "paid_at": "2024-01-01T00:00:00Z",
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    headers = HEADERS | {"X-Signature": "bad"}
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=headers,
        json=payload,
    )
    assert resp.status_code == 403


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
            "X-API-Key": os.getenv("API_KEY", "test-api-key"),
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
        headers={
            "X-API-Key": os.getenv("API_KEY", "test-api-key"),
            "X-API-Ver": "v1",
        },
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
        headers={
            "X-API-Key": os.getenv("API_KEY", "test-api-key"),
            "X-API-Ver": "v1",
            "X-Sign": sig,
        },
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
    assert second.status_code == 402


def test_sixth_diagnose_call_returns_402(client):
    """Ensure the 6th diagnose request fails with 402 by default."""
    for i in range(5):
        resp = client.post(
            "/v1/ai/diagnose",
            headers=HEADERS,
            json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
        )
        assert resp.status_code == 200, f"call {i}"

    sixth = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert sixth.status_code == 402
    data = sixth.json()
    assert data.get("error") == "limit_reached"


def test_paywall_disabled_returns_200(monkeypatch, client):
    monkeypatch.setattr("app.main.FREE_MONTHLY_LIMIT", 1)
    monkeypatch.setattr("app.main.PAYWALL_ENABLED", False)

    first = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert first.status_code == 200

    second = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert second.status_code == 200


def test_diagnose_old_sqlite_fallback(monkeypatch, client):
    """Fallback path for SQLite versions without RETURNING."""
    monkeypatch.setattr("sqlite3.sqlite_version_info", (3, 34, 0))
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    limits = client.get("/v1/limits", headers=HEADERS)
    assert limits.json()["used_this_month"] == 1


def test_pro_expired_event_logged(monkeypatch, client):
    monkeypatch.setattr("app.main.FREE_MONTHLY_LIMIT", 0)
    from app.db import SessionLocal
    from app.models import Event
    past = datetime(2024, 1, 1, tzinfo=timezone.utc)
    with SessionLocal() as session:
        session.execute(
            text(
                "INSERT OR IGNORE INTO users (id, tg_id, pro_expires_at) "
                "VALUES (1, 1, :dt)"
            ),
            {"dt": past},
        )
        session.commit()

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 402

    with SessionLocal() as session:
        event = session.query(Event).filter_by(user_id=1).order_by(Event.id.desc()).first()
        assert event.event == "pro_expired"
