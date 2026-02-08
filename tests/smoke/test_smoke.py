from __future__ import annotations
import subprocess
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import Settings
from app.dependencies import compute_signature
from sqlalchemy import text
from app.db import SessionLocal
from app.models import Photo
from tests.utils.auth import build_auth_headers
from tests.utils.consent import ensure_base_consents

client = TestClient(app)
SETTINGS = Settings()

def _headers(
    method: str, path: str, *, user_id: int = 1, body: object | None = None
) -> dict[str, str]:
    return build_auth_headers(
        method, path, user_id=user_id, api_key="test-api-key", body=body
    )

def _ensure_user(user_id: int = 1, api_key: str = "test-api-key") -> None:
    with SessionLocal() as session:
        session.execute(
            text(
                "INSERT OR IGNORE INTO users (id, tg_id, api_key) "
                "VALUES (:uid, :tg, :api_key)"
            ),
            {"uid": user_id, "tg": user_id, "api_key": api_key},
        )
        session.commit()

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

    headers = _headers(
        "POST",
        "/v1/payments/create",
        user_id=2,
        body={"user_id": 2, "plan": "pro", "months": 1},
    )
    _ensure_user(2)
    with SessionLocal() as session:
        ensure_base_consents(session, 2)

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
    sig = compute_signature(SETTINGS.hmac_secret, payload)
    payload["signature"] = sig
    resp = client.post(
        "/v1/payments/sbp/webhook",
        headers=_headers(
            "POST",
            "/v1/payments/sbp/webhook",
            user_id=2,
            body=payload,
        )
        | {"X-Sign": sig},
        json=payload,
    )
    assert resp.status_code == 200


@pytest.mark.smoke
def test_retry_queue():
    _ensure_user(1)
    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        photo = Photo(user_id=1, file_id="r.jpg", status="pending", ts=now)
        session.add(photo)
        session.commit()
        pid = photo.id

    resp = client.get(
        f"/v1/photos/{pid}",
        headers=_headers("GET", f"/v1/photos/{pid}"),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


@pytest.mark.smoke
def test_history_endpoint():
    _ensure_user(1)
    now = datetime.now(timezone.utc)
    with SessionLocal() as session:
        session.add(Photo(user_id=1, file_id="h.jpg", status="ok", ts=now))
        session.commit()

    resp = client.get(
        "/v1/photos/history",
        headers=_headers("GET", "/v1/photos/history"),
    )
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

    _ensure_user(1)
    resp = client.post(
        "/v1/ai/diagnose",
        headers=_headers(
            "POST",
            "/v1/ai/diagnose",
            body={"image_base64": "dGVzdA==", "prompt_id": "v1"},
        ),
        json={"image_base64": "dGVzdA==", "prompt_id": "v1"},
    )
    assert resp.status_code == 200


@pytest.mark.smoke
def test_bs4_import():
    import bs4  # noqa: F401


@pytest.mark.smoke
def test_pendulum_import():
    import pendulum  # noqa: F401
