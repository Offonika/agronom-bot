from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from app.db import SessionLocal
from app.services.plan_payload import normalize_plan_payload
from app.services.plan_service import create_event_with_reminder, create_plan_from_payload
from tests.utils.auth import build_auth_headers

API_KEY = os.getenv("API_KEY", "test-api-key")


def _headers(
    method: str,
    path: str,
    *,
    user_id: int = 101,
    body: object | None = None,
) -> dict[str, str]:
    return build_auth_headers(method, path, user_id=user_id, api_key=API_KEY, body=body)


def test_assistant_chat_builds_plan_from_recent_diagnosis(client):
    object_id = 2001
    _ensure_object(object_id, name="Яблоня")
    _seed_recent_diagnosis(
        object_id,
        {
            "crop": "apple",
            "crop_ru": "яблоня",
            "disease": "scab",
            "disease_name_ru": "парша",
            "confidence": 0.8,
            "reasoning": ["листья в пятнах"],
            "treatment_plan": {
                "product": "Скор",
                "substance": "дифеноконазол",
                "dosage_value": 2,
                "dosage_unit": "мл/10л",
                "method": "опрыскивание по листу",
                "phi_days": 30,
            },
            "assistant_followups_ru": ["Нужно перенести обработку?", "Добавить напоминание?"],
        },
    )

    resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Что делать с яблоней?", "object_id": object_id},
        ),
        json={"message": "Что делать с яблоней?", "object_id": object_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "парша" in data["assistant_message"].lower()
    assert data["proposals"]
    proposal = data["proposals"][0]
    assert proposal["plan_payload"]["stages"]
    option = proposal["plan_payload"]["stages"][0]["options"][0]
    assert option["product_name"] == "Скор"
    assert data["followups"]


def test_assistant_chat_summarizes_existing_plan(client):
    object_id = 2002
    _ensure_object(object_id, name="Смородина")
    _seed_plan_with_event(object_id)

    resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Что по плану?", "object_id": object_id},
        ),
        json={"message": "Что по плану?", "object_id": object_id},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "План для" in body["assistant_message"]
    assert "Ближайшая обработка" in body["assistant_message"]
    assert body["proposals"] == []
    assert body["followups"]


def test_assistant_chat_returns_without_proposals_when_storage_fails(client, monkeypatch):
    object_id = 2010
    _ensure_object(object_id, name="Груша")
    _seed_recent_diagnosis(
        object_id,
        {
            "crop": "pear",
            "crop_ru": "груша",
            "disease": "scab",
            "disease_name_ru": "парша",
            "confidence": 0.7,
            "treatment_plan": {"product": "Скор", "dosage_value": 2, "dosage_unit": "мл/10л"},
        },
    )

    import app.services.assistant as assistant_service

    async def _fail_save(*_args, **_kwargs):
        raise RuntimeError("storage down")

    monkeypatch.setattr(assistant_service, "save_proposal", _fail_save)

    resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Что делать с грушей?", "object_id": object_id},
        ),
        json={"message": "Что делать с грушей?", "object_id": object_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "парша" in data["assistant_message"].lower()
    assert data["proposals"] == []
    assert data["followups"]


def test_assistant_chat_uses_stages_when_payload_missing(client):
    object_id = 2004
    _ensure_object(object_id, name="Лаванда")
    plan_id = _seed_plan_with_event(object_id)
    with SessionLocal() as session:
        session.execute(text("UPDATE plans SET payload=NULL WHERE id=:pid"), {"pid": plan_id})
        session.commit()

    resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Расскажи про план", "object_id": object_id},
        ),
        json={"message": "Расскажи про план", "object_id": object_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "Основные обработки" in data["assistant_message"]
    assert "Топаз" in data["assistant_message"]


def test_assistant_confirm_success(client):
    object_id = 2003
    _ensure_object(object_id, name="Томат")
    _seed_recent_diagnosis(
        object_id,
        {
            "crop": "tomato",
            "crop_ru": "томат",
            "disease": "blight",
            "disease_name_ru": "фитофтороз",
            "confidence": 0.9,
            "treatment_plan": {
                "product": "Ридомил",
                "substance": "металаксил",
                "dosage_value": 25,
                "dosage_unit": "г/10л",
                "method": "обработка по листу",
                "phi_days": 20,
            },
        },
    )

    chat_resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Зафиксируй обработку завтра", "object_id": object_id},
        ),
        json={"message": "Зафиксируй обработку завтра", "object_id": object_id},
    )
    proposal_id = chat_resp.json()["proposals"][0]["proposal_id"]

    confirm = client.post(
        "/v1/assistant/confirm_plan",
        headers=_headers(
            "POST",
            "/v1/assistant/confirm_plan",
            body={"proposal_id": proposal_id, "object_id": object_id},
        ),
        json={"proposal_id": proposal_id, "object_id": object_id},
    )
    assert confirm.status_code == 200
    body = confirm.json()
    assert body["status"] == "accepted"
    assert body["plan_id"]
    assert body["event_ids"] or body["reminder_ids"]


def test_assistant_proposal_audit_trail(client):
    object_id = 3001
    _ensure_object(object_id, name="Черешня")
    _seed_recent_diagnosis(
        object_id,
        {
            "crop": "cherry",
            "crop_ru": "черешня",
            "disease": "fungus",
            "disease_name_ru": "грибок",
            "confidence": 0.7,
            "treatment_plan": {"product": "Хорус", "dosage_value": 3, "dosage_unit": "г/10л"},
        },
    )

    chat_resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Что делать?", "object_id": object_id},
        ),
        json={"message": "Что делать?", "object_id": object_id},
    )
    proposal_id = chat_resp.json()["proposals"][0]["proposal_id"]
    pending = _get_proposal_row(proposal_id)
    assert pending is not None
    assert pending["status"] == "pending"

    confirm = client.post(
        "/v1/assistant/confirm_plan",
        headers=_headers(
            "POST",
            "/v1/assistant/confirm_plan",
            body={"proposal_id": proposal_id, "object_id": object_id},
        ),
        json={"proposal_id": proposal_id, "object_id": object_id},
    ).json()
    row = _get_proposal_row(proposal_id)
    assert row["status"] == "confirmed"
    assert row["plan_id"] == confirm["plan_id"]
    assert row["event_ids"] == confirm["event_ids"]


def test_assistant_proposal_failed_status_on_mismatch(client):
    base_id = 3002
    _ensure_object(base_id, name="Груша")
    _ensure_object(base_id + 1, name="Дубль")
    _seed_recent_diagnosis(
        base_id,
        {
            "crop": "pear",
            "crop_ru": "груша",
            "disease": "scab",
            "disease_name_ru": "парша",
            "confidence": 0.9,
            "treatment_plan": {"product": "Скор"},
        },
    )
    chat_resp = client.post(
        "/v1/assistant/chat",
        headers=_headers(
            "POST",
            "/v1/assistant/chat",
            body={"message": "Есть план?", "object_id": base_id},
        ),
        json={"message": "Есть план?", "object_id": base_id},
    )
    proposal_id = chat_resp.json()["proposals"][0]["proposal_id"]
    resp = client.post(
        "/v1/assistant/confirm_plan",
        headers=_headers(
            "POST",
            "/v1/assistant/confirm_plan",
            body={"proposal_id": proposal_id, "object_id": base_id + 1},
        ),
        json={"proposal_id": proposal_id, "object_id": base_id + 1},
    )
    assert resp.status_code == 400
    row = _get_proposal_row(proposal_id)
    assert row["status"] == "failed"
    assert row["error_code"] == "OBJECT_MISMATCH"


def test_assistant_confirm_not_found(client):
    resp = client.post(
        "/v1/assistant/confirm_plan",
        headers=_headers(
            "POST",
            "/v1/assistant/confirm_plan",
            body={"proposal_id": "missing", "object_id": 1},
        ),
        json={"proposal_id": "missing", "object_id": 1},
    )
    assert resp.status_code == 404


def _ensure_object(object_id: int, user_id: int = 101, name: str = "Test object") -> None:
    with SessionLocal() as session:
        session.execute(
            text(
                """
                INSERT INTO objects (id, user_id, name, meta)
                VALUES (:oid, :uid, :name, '{}')
                ON CONFLICT (id) DO UPDATE SET name=:name
                """
            ),
            {"oid": object_id, "uid": user_id, "name": name},
        )
        session.commit()


def _seed_recent_diagnosis(object_id: int, payload: dict[str, Any], user_id: int = 101) -> None:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(hours=24)
    with SessionLocal() as session:
        session.execute(
            text(
                "DELETE FROM recent_diagnoses WHERE user_id=:uid AND object_id=:oid"
            ),
            {"uid": user_id, "oid": object_id},
        )
        session.execute(
            text(
                """
                INSERT INTO recent_diagnoses (user_id, object_id, diagnosis_payload, created_at, expires_at)
                VALUES (:uid, :oid, :payload, :created, :expires)
                """
            ),
            {
                "uid": user_id,
                "oid": object_id,
                "payload": json.dumps(payload),
                "created": now.isoformat(),
                "expires": expires.isoformat(),
            },
        )
        session.commit()


def _seed_plan_with_event(object_id: int, user_id: int = 101) -> int:
    plan_payload = {
        "kind": "PLAN_NEW",
        "object_hint": "Смородина",
        "diagnosis": {"crop": "currant", "disease": "powdery_mildew", "confidence": 0.8},
        "stages": [
            {
                "name": "До цветения",
                "trigger": "в ближайшее окно",
                "options": [
                    {
                        "product_name": "Топаз",
                        "ai": "пенконазол",
                        "dose_value": 2,
                        "dose_unit": "мл/10л",
                        "method": "опрыскивание",
                    }
                ],
            }
        ],
    }
    normalized = normalize_plan_payload(plan_payload)
    result = create_plan_from_payload(user_id, object_id, normalized, plan_payload)
    stage = result.stages[0] if result.stages else None
    if result.plan_id and stage and stage.stage_id:
        create_event_with_reminder(
            user_id=user_id,
            plan_id=result.plan_id,
            stage_id=stage.stage_id,
            stage_option_id=stage.option_ids[0] if stage.option_ids else None,
            due_at_iso=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
        )
    return result.plan_id or 0


def _get_proposal_row(proposal_id: str) -> dict[str, Any] | None:
    with SessionLocal() as session:
        row = (
            session.execute(
                text("SELECT status, plan_id, event_ids, error_code FROM assistant_proposals WHERE proposal_id=:pid"),
                {"pid": proposal_id},
            )
            .mappings()
            .first()
        )
        if not row:
            return None
        data = dict(row)
        for key in ("event_ids",):
            value = data.get(key)
            if isinstance(value, str):
                try:
                    data[key] = json.loads(value)
                except json.JSONDecodeError:
                    data[key] = []
        return data
