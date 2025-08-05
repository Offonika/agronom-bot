import subprocess
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.dependencies import compute_signature
from sqlalchemy import text
from app.db import SessionLocal
from app.models import Photo

client = TestClient(app)

HEADERS = {
    "X-API-Key": "test-api-key",
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}


@pytest.fixture(autouse=True)
def stub_upload(monkeypatch):
    async def _stub(user_id: int, data: bytes) -> str:
        return "1/stub.jpg"

    monkeypatch.setattr("app.services.storage.upload_photo", _stub)
    monkeypatch.setattr("app.controllers.photos.upload_photo", _stub)


@pytest.mark.smoke
def test_start_to_diagnose():
    """Run bot start→diagnose scenario via Node tests."""
    result = subprocess.run(
        [
            "node",
            "--test",
            "--test-name-pattern=photoHandler stores",
            "bot/handlers.test.js",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.smoke
def test_paywall_with_mock_payment(monkeypatch):
    monkeypatch.setattr("app.controllers.photos.FREE_MONTHLY_LIMIT", 0)

    headers = HEADERS | {"X-User-ID": "2"}
    with SessionLocal() as session:
        session.execute(text("INSERT OR IGNORE INTO users (id, tg_id) VALUES (2, 2)"))
        session.commit()

    create = client.post(
        "/v1/payments/create",
        headers=headers,
        json={"user_id": 2, "plan": "pro", "months": 1},
    )
    assert create.status_code == 200
    payment_id = create.json()["payment_id"]

    now = datetime.now(timezone.utc)
    payload = {
        "external_id": payment_id,
        "status": "success",
        "paid_at": now.isoformat().replace("+00:00", "Z"),
    }
    sig = compute_signature("test-hmac-secret", payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=headers | {"X-Sign": sig},
        json=payload,
    )
    assert resp.status_code == 200


@pytest.mark.smoke
def test_retry_queue():
    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="r.jpg", status="pending", ts=now)
        session.add(photo)
        session.commit()
        pid = photo.id

    resp = client.get(f"/v1/photos/{pid}", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


@pytest.mark.smoke
def test_history_endpoint():
    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        session.add(Photo(user_id=1, file_id="h.jpg", status="ok", ts=now))
        session.commit()

    resp = client.get("/v1/photos/history", headers=HEADERS)
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.smoke
def test_help_command():
    result = subprocess.run(
        [
            "node",
            "--test",
            "--test-name-pattern=helpHandler",
            "bot/handlers.test.js",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.smoke
def test_camelot_import():
    pytest.importorskip("camelot", exc_type=ImportError, reason="Camelot not installed")

    resp = client.post(
        "/v1/ai/diagnose",
        headers=HEADERS,
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200


@pytest.mark.smoke
def test_bs4_import():
    import bs4  # noqa: F401


@pytest.mark.smoke
def test_pendulum_import():
    import pendulum  # noqa: F401
