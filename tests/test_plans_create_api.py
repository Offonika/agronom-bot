from __future__ import annotations

import os

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "5001",
}


def _plan_payload():
    return {
        "kind": "PLAN_NEW",
        "diagnosis": {"crop": "tomato", "disease": "blight", "confidence": 0.9},
        "stages": [
            {
                "name": "Обработка 1",
                "trigger": "по согласованию",
                "options": [
                    {
                        "product_name": "Препарат А",
                        "dose_value": 1.0,
                        "dose_unit": "л/га",
                        "method": "опрыскивание",
                        "phi_days": 30,
                        "needs_review": False,
                    }
                ],
            }
        ],
    }


def test_create_plan_event_autoplan(client):
    # создаём объект для пользователя
    from app.db import SessionLocal
    from sqlalchemy import text

    with SessionLocal() as session:
        session.execute(
            text(
                """
                INSERT INTO objects (id, user_id, name, meta)
                VALUES (:oid, :uid, 'Test object', '{}')
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {"oid": 7001, "uid": int(HEADERS["X-User-ID"])},
        )
        session.commit()

    # Создать план
    resp = client.post(
        "/v1/plans",
        headers=HEADERS,
        json={"object_id": 7001, "plan_payload": _plan_payload()},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["plan_id"]
    assert data["stages"]
    stage_id = data["stages"][0]["stage_id"]
    option_id = data["stages"][0]["option_ids"][0]

    # Создать событие
    event_resp = client.post(
        f"/v1/plans/{data['plan_id']}/events",
        headers=HEADERS,
        json={"stage_id": stage_id, "stage_option_id": option_id},
    )
    assert event_resp.status_code == 200
    event_data = event_resp.json()
    assert event_data["event_ids"]

    # Автоплан
    autoplan_resp = client.post(
        f"/v1/plans/{data['plan_id']}/autoplan",
        headers=HEADERS,
        json={"stage_id": stage_id, "stage_option_id": option_id},
    )
    assert autoplan_resp.status_code == 202
    auto_data = autoplan_resp.json()
    assert auto_data["autoplan_run_id"]


def test_create_plan_for_foreign_object_forbidden(client):
    # создаём объект другого пользователя
    resp = client.post(
        "/v1/plans",
        headers=HEADERS,
        json={"object_id": 99999, "plan_payload": _plan_payload()},
    )
    assert resp.status_code == 403


def test_create_plan_without_options_fails(client):
    from app.db import SessionLocal
    from sqlalchemy import text

    with SessionLocal() as session:
        session.execute(
            text(
                "INSERT INTO objects (id, user_id, name, meta) VALUES (:oid, :uid, 'No options', '{}') ON CONFLICT (id) DO NOTHING"
            ),
            {"oid": 8001, "uid": int(HEADERS["X-User-ID"])},
        )
        session.commit()

    bad_payload = {"kind": "PLAN_NEW", "stages": [{"name": "Пусто", "options": []}]}
    resp = client.post(
        "/v1/plans",
        headers=HEADERS,
        json={"object_id": 8001, "plan_payload": bad_payload},
    )
    assert resp.status_code == 400
