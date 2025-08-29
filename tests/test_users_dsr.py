import io
import json
import zipfile
import pytest

from app.config import Settings
from app.db import SessionLocal
from app.dependencies import compute_signature
from app.models import Event, Payment, Photo, PhotoUsage, User

HEADERS = {
    "X-API-Key": "test-api-key",
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}

HMAC_SECRET = Settings().hmac_secret


def _prepare_db():
    with SessionLocal() as db:
        db.query(Photo).filter_by(user_id=1).delete()
        db.query(Payment).filter_by(user_id=1).delete()
        db.query(Event).filter_by(user_id=1).delete()
        db.query(PhotoUsage).filter_by(user_id=1).delete()
        db.query(User).filter_by(id=1).delete()
        db.add(User(id=1, tg_id=1))
        db.add(Photo(user_id=1, file_id="f1"))
        db.add(
            Payment(
                user_id=1,
                amount=100,
                currency="RUB",
                provider="test",
                status="success",
            )
        )
        db.add(Event(user_id=1, event="login"))
        db.add(PhotoUsage(user_id=1, month="2024-01", used=1))
        db.commit()


def _prepare_db_many(n: int):
    with SessionLocal() as db:
        db.query(Photo).filter_by(user_id=1).delete()
        db.query(Payment).filter_by(user_id=1).delete()
        db.query(Event).filter_by(user_id=1).delete()
        db.query(User).filter_by(id=1).delete()
        db.add(User(id=1, tg_id=1))
        for i in range(n):
            db.add(Photo(user_id=1, file_id=f"f{i}"))
            db.add(
                Payment(
                    user_id=1,
                    amount=100,
                    currency="RUB",
                    provider="test",
                    status="success",
                )
            )
            db.add(Event(user_id=1, event="login"))
        db.commit()


def test_export_user_data(client):
    _prepare_db()
    sig = compute_signature(HMAC_SECRET, {"user_id": 1})
    resp = client.get(
        "/v1/users/1/export", headers=HEADERS | {"X-Sign": sig}
    )
    assert resp.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    data = json.loads(zf.read("data.json"))
    assert len(data["photos"]) == 1
    assert len(data["payments"]) == 1
    assert len(data["events"]) == 1

    photo_keys = {
        "file_id",
        "file_unique_id",
        "width",
        "height",
        "file_size",
        "crop",
        "disease",
        "confidence",
        "roi",
        "status",
        "error_code",
        "ts",
    }
    payment_keys = {
        "amount",
        "currency",
        "provider",
        "external_id",
        "prolong_months",
        "autopay",
        "status",
        "created_at",
        "updated_at",
    }
    event_keys = {"event", "ts"}

    assert set(data["photos"][0].keys()) == photo_keys
    assert set(data["payments"][0].keys()) == payment_keys
    assert set(data["events"][0].keys()) == event_keys


def test_export_bad_signature(client):
    _prepare_db()
    resp = client.get(
        "/v1/users/1/export", headers=HEADERS | {"X-Sign": "bad"}
    )
    assert resp.status_code == 401


def test_export_large_dataset_streaming(client):
    _prepare_db_many(1000)
    sig = compute_signature(HMAC_SECRET, {"user_id": 1})
    import tracemalloc

    tracemalloc.start()
    with client.stream(
        "GET", "/v1/users/1/export", headers=HEADERS | {"X-Sign": sig}
    ) as resp:
        assert resp.status_code == 200
        for _ in resp.iter_bytes():
            pass
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak < 50 * 1024 * 1024


def test_delete_user_cascade(client):
    _prepare_db()
    sig = compute_signature(HMAC_SECRET, {"user_id": 1})
    resp = client.post(
        "/v1/dsr/delete_user",
        headers=HEADERS | {"X-Sign": sig},
        json={"user_id": 1},
    )
    assert resp.status_code == 200
    with SessionLocal() as db:
        assert db.query(User).filter_by(id=1).first() is None
        assert db.query(Photo).filter_by(user_id=1).count() == 0
        assert db.query(Payment).filter_by(user_id=1).count() == 0
        assert db.query(Event).filter_by(user_id=1).count() == 0
        assert db.query(PhotoUsage).filter_by(user_id=1).count() == 0


def test_delete_user_bad_signature(client):
    _prepare_db()
    resp = client.post(
        "/v1/dsr/delete_user",
        headers=HEADERS | {"X-Sign": "bad"},
        json={"user_id": 1},
    )
    assert resp.status_code == 401


def test_delete_user_forbidden(client):
    _prepare_db()
    sig = compute_signature(HMAC_SECRET, {"user_id": 1})
    headers = HEADERS | {"X-User-ID": "2", "X-Sign": sig}
    resp = client.post(
        "/v1/dsr/delete_user", headers=headers, json={"user_id": 1}
    )
    assert resp.status_code == 403



@pytest.mark.parametrize("user_id", ["oops", ["1"]])
def test_delete_user_invalid_user_id_type(client, user_id):
    _prepare_db()
    sig = compute_signature(HMAC_SECRET, {"user_id": user_id})
    resp = client.post(
        "/v1/dsr/delete_user",
        headers=HEADERS | {"X-Sign": sig},
        json={"user_id": user_id},
    )
    assert resp.status_code == 400


def test_delete_user_success_int_id(client):
    _prepare_db()
    sig = compute_signature(HMAC_SECRET, {"user_id": 1})
    resp = client.post(
        "/v1/dsr/delete_user",
        headers=HEADERS | {"X-Sign": sig},
        json={"user_id": 1},
    )
    assert resp.status_code == 200
