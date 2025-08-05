import json
import base64
import os
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from sqlalchemy import text
from app.dependencies import compute_signature, verify_hmac
from app.config import Settings
from app.db import SessionLocal
from app.models import Catalog, CatalogItem


def seed_protocol():
    with SessionLocal() as session:
        session.execute(text("DELETE FROM catalog_items"))
        session.execute(text("DELETE FROM catalogs"))

        session.execute(
            text(
                """
                CREATE VIEW IF NOT EXISTS protocols_current AS
                SELECT ci.id AS id,
                       c.crop AS crop,
                       c.disease AS disease,
                       ci.product AS product,
                       ci.dosage_value AS dosage_value,
                       ci.dosage_unit AS dosage_unit,
                       ci.phi AS phi
                FROM catalog_items ci
                JOIN catalogs c ON c.id = ci.catalog_id
                WHERE ci.is_current = 1
                """
            )
        )

        def _add(crop: str, disease: str, product: str, dosage_value: float, dosage_unit: str, phi: int):
            catalog = Catalog(crop=crop, disease=disease)
            session.add(catalog)
            session.flush()
            item = CatalogItem(
                catalog_id=catalog.id,
                product=product,
                dosage_value=dosage_value,
                dosage_unit=dosage_unit,
                phi=phi,
                is_current=True,
            )
            session.add(item)

        _add("apple", "powdery_mildew", "Скор 250 ЭК", 2, "ml_10l", 30)
        _add("apple", "scab", "Хорус 75 ВДГ", 3, "g_per_l", 28)
        session.commit()


@pytest.fixture(autouse=True)
def stub_upload(monkeypatch):
    """Prevent real S3 calls by stubbing upload_photo."""
    async def _stub(user_id: int, data: bytes) -> str:
        return "1/stub.jpg"

    monkeypatch.setattr("app.services.storage.upload_photo", _stub)
    monkeypatch.setattr("app.controllers.photos.upload_photo", _stub)
    # reset usage to avoid 402 errors between tests
    from app.db import SessionLocal
    from app.models import PhotoUsage
    from app.services.protocols import _cache_protocol

    with SessionLocal() as session:
        session.query(PhotoUsage).delete()
        session.commit()

    _cache_protocol.cache_clear()

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}

PARTNER_SECRET = Settings().hmac_secret_partner


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
        "roi",
    }
    assert body["roi"] == 1.9


def test_diagnose_multipart_success(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("leaf.jpg", b"x" * 10, "image/jpeg")},
    )
    assert resp.status_code == 200


def test_diagnose_multipart_uses_process(monkeypatch, client):
    async def fake_process(
        contents: bytes, user_id: int
    ) -> tuple[str, str, str, float, float]:
        assert contents == b"abc"
        return "k", "wheat", "rust", 0.5, 2.1

    monkeypatch.setattr("app.controllers.photos._process_image", fake_process)
    monkeypatch.setattr("app.controllers.photos.find_protocol", lambda *_, **__: None)
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        files={"image": ("leaf.jpg", b"abc", "image/jpeg")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["crop"] == "wheat"
    assert data["disease"] == "rust"
    assert data["confidence"] == 0.5
    assert data["roi"] == 2.1


def test_diagnose_base64_uses_process(monkeypatch, client):
    async def fake_process(
        contents: bytes, user_id: int
    ) -> tuple[str, str, str, float, float]:
        assert contents == b"xyz"
        return "k", "corn", "blight", 0.7, 3.3

    monkeypatch.setattr("app.controllers.photos._process_image", fake_process)
    monkeypatch.setattr("app.controllers.photos.find_protocol", lambda *_, **__: None)
    encoded = base64.b64encode(b"xyz").decode()
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": encoded, "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["crop"] == "corn"
    assert data["disease"] == "blight"
    assert data["confidence"] == 0.7
    assert data["roi"] == 3.3


def test_diagnose_missing_api_version(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "test-api-key", "X-User-ID": "1"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 426
    assert resp.json()["detail"]["code"] == "UPGRADE_REQUIRED"


def test_diagnose_invalid_api_version(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers={"X-API-Key": "test-api-key", "X-API-Ver": "v2", "X-User-ID": "1"},
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 426
    assert resp.json()["detail"]["code"] == "UPGRADE_REQUIRED"


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
    seed_protocol()
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["crop"] == "apple"
    assert body["disease"] == "powdery_mildew"
    assert body["confidence"] == 0.92
    assert body["roi"] == 1.9
    assert body["protocol_status"] is None
    proto = body["protocol"]
    assert proto is not None
    assert proto["product"] == "Скор 250 ЭК"
    assert proto["dosage_value"] == 2.0
    assert proto["dosage_unit"] == "ml_10l"
    assert proto["phi"] == 30


def test_diagnose_saves_roi(client):
    seed_protocol()
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200
    roi = resp.json()["roi"]

    from app.db import SessionLocal
    from app.models import Photo

    with SessionLocal() as session:
        photo = session.query(Photo).order_by(Photo.id.desc()).first()
        assert photo is not None
        assert photo.roi == roi


def test_diagnose_without_protocol(client):
    from app.db import SessionLocal
    from app.models import CatalogItem

    session = SessionLocal()
    session.query(CatalogItem).delete()
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
    assert "roi" in data


def test_diagnose_json_bad_prompt(client):
    before = client.get("/v1/limits", headers=HEADERS)
    assert before.status_code == 200
    used_before = before.json()["used_this_month"]

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v2"},
    )
    assert resp.status_code == 400
    data = resp.json()
    assert data["code"] == "BAD_REQUEST"
    assert "prompt_id" in data["message"]

    after = client.get("/v1/limits", headers=HEADERS)
    assert after.status_code == 200
    assert after.json()["used_this_month"] == used_before


def test_diagnose_json_missing_prompt(client):
    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA=="},
    )
    assert resp.status_code == 400
    data = resp.json()
    assert data["code"] == "BAD_REQUEST"
    assert "Field required" in data["message"]


def test_diagnose_invalid_base64(client):
    before = client.get("/v1/limits", headers=HEADERS)
    assert before.status_code == 200
    used_before = before.json()["used_this_month"]

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==@@", "prompt_id": "v1"},
    )
    assert resp.status_code == 400

    after = client.get("/v1/limits", headers=HEADERS)
    assert after.status_code == 200
    assert after.json()["used_this_month"] == used_before


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

    monkeypatch.setattr("app.controllers.photos.call_gpt_vision_stub", _fail)

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code in {200, 202}
    data = resp.json()
    assert data["status"] == "pending"
    assert "id" in data

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


def test_limits_missing_user_id(client):
    headers = HEADERS.copy()
    headers.pop("X-User-ID")
    resp = client.get("/v1/limits", headers=headers)
    assert resp.status_code == 401
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


def test_photos_history_limit_offset(client):
    from app.db import SessionLocal
    from app.models import Photo
    with SessionLocal() as session:
        p1 = Photo(user_id=1, file_id="a.jpg", status="ok", ts=datetime(2024, 1, 1, tzinfo=timezone.utc))
        p2 = Photo(user_id=1, file_id="b.jpg", status="ok", ts=datetime(2024, 1, 2, tzinfo=timezone.utc))
        p3 = Photo(user_id=1, file_id="c.jpg", status="ok", ts=datetime(2024, 1, 3, tzinfo=timezone.utc))
        session.add_all([p1, p2, p3])
        session.commit()
        expected = (
            session.query(Photo)
            .filter_by(user_id=1)
            .order_by(Photo.ts.desc())
            .limit(2)
            .offset(1)
            .all()
        )
        expected_ids = [p.id for p in expected]

    resp = client.get("/v1/photos/history?limit=2&offset=1", headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert [item["photo_id"] for item in data] == expected_ids


def test_photos_history_forbidden_other_user(client):
    headers = HEADERS | {"X-User-ID": "2"}
    resp = client.get("/v1/photos/history", headers=headers)
    assert resp.status_code == 200


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


def test_photo_retry_attempts_default(client):
    from app.db import SessionLocal
    from app.models import Photo

    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="test.jpg", status="pending")
        session.add(photo)
        session.commit()
        pid = photo.id

    with SessionLocal() as session:
        db_photo = session.get(Photo, pid)
        assert db_photo.retry_attempts == 0


def test_photo_status_completed(client):
    from app.db import SessionLocal
    from app.models import Photo
    seed_protocol()

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


def test_create_payment_valid_json(client):
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


def test_create_payment_invalid_json(client):
    resp = client.post(
        "/v1/payments/create",
        headers=HEADERS | {"Content-Type": "application/json"},
        content="{not-valid",
    )
    assert resp.status_code == 400
    assert resp.json() == {"detail": "BAD_REQUEST"}


def test_create_payment_user_id_mismatch(client):
    payload = {"user_id": 2, "plan": "pro", "months": 1}
    resp = client.post("/v1/payments/create", headers=HEADERS, json=payload)
    assert resp.status_code == 401


@pytest.mark.parametrize("plan", ["basic", "PRO", ""])
def test_create_payment_invalid_plan(client, plan):
    payload = {"user_id": 1, "plan": plan, "months": 1}
    resp = client.post("/v1/payments/create", headers=HEADERS, json=payload)
    assert resp.status_code == 400


@pytest.mark.parametrize("months", [0, 13])
def test_create_payment_invalid_months(client, months):
    payload = {"user_id": 1, "plan": "pro", "months": months}
    resp = client.post("/v1/payments/create", headers=HEADERS, json=payload)
    assert resp.status_code == 400


def test_payment_status_user_scoped(client):
    from app.db import SessionLocal
    from app.models import Payment

    external_id = "paystatus1"
    with SessionLocal() as session:
        payment = Payment(
            user_id=1,
            amount=100,
            currency="RUB",
            provider="sbp",
            external_id=external_id,
            status="pending",
        )
        session.add(payment)
        session.commit()

    # owner can fetch status
    resp_owner = client.get(f"/v1/payments/{external_id}", headers=HEADERS)
    assert resp_owner.status_code == 200

    # another user should receive 404
    headers_other = HEADERS | {"X-User-ID": "2"}
    resp_other = client.get(
        f"/v1/payments/{external_id}", headers=headers_other
    )
    assert resp_other.status_code == 404


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
    headers = HEADERS | {"X-Sign": sig}
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
        headers=HEADERS | {"X-Sign": sig},
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
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        assert expires > paid_at
        session.execute(text("UPDATE users SET pro_expires_at=NULL WHERE id=1"))
        session.commit()


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
        headers=HEADERS | {"X-Sign": sig},
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
    sig = compute_signature(PARTNER_SECRET, payload)
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
    sig = compute_signature(PARTNER_SECRET, payload)
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
    sig = compute_signature(PARTNER_SECRET, payload)
    payload["signature"] = "invalid"
    body = json.dumps(payload).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http"}, receive)
    with pytest.raises(HTTPException) as exc:
        await verify_hmac(request, sig)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_verify_hmac_bad_json(client):
    payload = [1, 2, 3]
    body = json.dumps(payload).encode()

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request = Request({"type": "http"}, receive)
    with pytest.raises(HTTPException) as exc:
        await verify_hmac(request, "sig")
    assert exc.value.status_code == 400


def test_payment_webhook_bad_body_signature_returns_403(client):
    payload = {
        "external_id": "1",
        "status": "success",
        "paid_at": "2024-01-01T00:00:00Z",
    }
    _ = compute_signature("test-hmac-secret", payload)
    payload["signature"] = "wrong"
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=HEADERS,
        json=payload,
    )
    assert resp.status_code == 403


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
        headers=HEADERS | {"X-Sign": sig},
        json=payload,
    )
    assert resp.status_code in {400, 422}


def test_payment_webhook_bad_signature_returns_403(client, monkeypatch, caplog):
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
    headers = HEADERS | {"X-Sign": "bad"}
    with caplog.at_level("WARNING"):
        resp = client.post(
            "/v1/payments/sbp/webhook",
            headers=headers,
            json=payload,
        )
    assert resp.status_code == 403
    assert any("audit: invalid webhook signature" in r.message for r in caplog.records)


def test_partner_order_success(client):
    payload = {
        "order_id": "o1",
        "user_tg_id": 1,
        "protocol_id": 2,
        "price_kopeks": 100,
    }
    sig = compute_signature(PARTNER_SECRET, payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/partner/orders",
        headers={
            "X-API-Key": os.getenv("API_KEY", "test-api-key"),
            "X-API-Ver": "v1",
            "X-User-ID": "1",
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
            "X-User-ID": "1",
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
    sig = compute_signature(PARTNER_SECRET, payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/partner/orders",
        headers={
            "X-API-Key": os.getenv("API_KEY", "test-api-key"),
            "X-API-Ver": "v1",
            "X-User-ID": "1",
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
    seed_protocol()
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
    from app.models import CatalogItem

    session = SessionLocal()
    session.query(CatalogItem).delete()
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


def test_diagnose_missing_protocols_table(client):
    """Diagnose should gracefully handle a missing protocols table."""
    from app.db import SessionLocal
    from sqlalchemy import text
    import subprocess

    with SessionLocal() as session:
        session.execute(text("DROP VIEW IF EXISTS protocols_current"))
        session.commit()

    try:
        resp = client.post(
            "/v1/ai/diagnose",
            headers=HEADERS,
            json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["protocol"] is None
        assert data["protocol_status"] == "Бета"
    finally:
        subprocess.run(["alembic", "upgrade", "head"], check=True)
        seed_protocol()


def test_free_monthly_limit_env(monkeypatch, client):
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 1)
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


def test_usage_count_persists_when_paywall_hit(monkeypatch, client):
    """Usage counter should increment even if paywall returns 402."""
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 1)

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
    assert second.status_code == 402

    limits = client.get("/v1/limits", headers=HEADERS)
    assert limits.status_code == 200
    assert limits.json()["used_this_month"] == 2


def test_sixth_diagnose_call_returns_402(monkeypatch, client):
    """Ensure the 6th diagnose request fails with 402 by default."""
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 5)
    limit = 5
    for i in range(limit):
        headers = HEADERS.copy()
        headers["X-Forwarded-For"] = f"10.0.0.{i}"
        resp = client.post(
            "/v1/ai/diagnose",
            headers=headers,
            json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
        )
        assert resp.status_code == 200, f"call {i}"

    limits = client.get("/v1/limits", headers=HEADERS)
    assert limits.status_code == 200
    assert limits.json()["used_this_month"] == limit

    sixth_headers = HEADERS.copy()
    sixth_headers["X-Forwarded-For"] = f"10.0.0.{limit}"
    sixth = client.post(
        "/v1/ai/diagnose",
        headers=sixth_headers,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert sixth.status_code == 402
    data = sixth.json()
    assert data.get("error") == "limit_reached"


def test_paywall_disabled_returns_200(monkeypatch, client):
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 1)
    monkeypatch.setattr("app.controllers.photos.PAYWALL_ENABLED", False)

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


@pytest.mark.asyncio
async def test_paywall_helper_enforces_limit(monkeypatch):
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 1)
    monkeypatch.setattr("app.controllers.photos.PAYWALL_ENABLED", True)

    from app.controllers.photos import _enforce_paywall

    first = await _enforce_paywall(1)
    assert first is None

    second = await _enforce_paywall(1)
    assert second is not None
    assert second.status_code == 402
    body = json.loads(second.body.decode())
    assert body == {"error": "limit_reached", "limit": 1}


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
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 0)
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
        session.execute(
            text("UPDATE users SET pro_expires_at=:dt WHERE id=1"),
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
        events = session.query(Event).filter_by(user_id=1).all()
        assert any(e.event == "pro_expired" for e in events)

    # cleanup to not affect other tests
    with SessionLocal() as session:
        session.execute(text("UPDATE users SET pro_expires_at=NULL WHERE id=1"))
        session.commit()
