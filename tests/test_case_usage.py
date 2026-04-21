from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.db import SessionLocal
from app.services.case_usage import get_recent_case_for_same_plant_sync


def _seed_recent_cases(user_id: int) -> None:
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.execute(text("DELETE FROM cases WHERE user_id = :uid"), {"uid": user_id})
        db.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        db.execute(
            text(
                "INSERT INTO users (id, tg_id, api_key, created_at) "
                "VALUES (:uid, :tg_id, :api_key, CURRENT_TIMESTAMP)"
            ),
            {"uid": user_id, "tg_id": user_id, "api_key": f"test-key-{user_id}"},
        )
        db.execute(
            text(
                "INSERT INTO cases (id, user_id, object_id, crop, disease, confidence, raw_ai, created_at) "
                "VALUES (:id, :uid, :object_id, :crop, :disease, :confidence, :raw_ai, :created_at)"
            ),
            {
                "id": user_id * 10 + 1,
                "uid": user_id,
                "object_id": 101,
                "crop": "огурец",
                "disease": "mildew",
                "confidence": 0.77,
                "raw_ai": "{}",
                "created_at": now - timedelta(hours=2),
            },
        )
        db.execute(
            text(
                "INSERT INTO cases (id, user_id, object_id, crop, disease, confidence, raw_ai, created_at) "
                "VALUES (:id, :uid, :object_id, :crop, :disease, :confidence, :raw_ai, :created_at)"
            ),
            {
                "id": user_id * 10 + 2,
                "uid": user_id,
                "object_id": 202,
                "crop": "алоказия",
                "disease": "root_rot",
                "confidence": 0.83,
                "raw_ai": "{}",
                "created_at": now - timedelta(minutes=10),
            },
        )
        db.commit()


def test_get_recent_case_for_same_plant_without_object_filter_returns_latest() -> None:
    user_id = 990001
    _seed_recent_cases(user_id)

    record = get_recent_case_for_same_plant_sync(user_id=user_id, max_age_days=10)

    assert record is not None
    assert record["object_id"] == 202
    assert record["crop"] == "алоказия"


def test_get_recent_case_for_same_plant_with_object_filter_returns_matching_object() -> None:
    user_id = 990002
    _seed_recent_cases(user_id)

    record = get_recent_case_for_same_plant_sync(user_id=user_id, max_age_days=10, object_id=101)

    assert record is not None
    assert record["object_id"] == 101
    assert record["crop"] == "огурец"
