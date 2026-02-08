from __future__ import annotations

import json

import pytest
from sqlalchemy import text

from app.db import SessionLocal
from tests.utils.auth import build_auth_headers


def insert_plan_fixture():
    with SessionLocal() as session:
        user_id = 9101
        object_id = 9201
        case_id = 9301
        plan_id = 9401
        stage_id = 9501
        option_id = 9601
        session.execute(
            text(
                """
                INSERT INTO users (id, tg_id, created_at)
                VALUES (:id, :tg, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {"id": user_id, "tg": 555555},
        )
        session.execute(
            text(
                """
                INSERT INTO objects (id, user_id, name, meta)
                VALUES (:id, :uid, 'Тестовая грядка', '{}')
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {"id": object_id, "uid": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO cases (id, user_id, object_id, crop, disease, confidence, raw_ai)
                VALUES (:id, :uid, :oid, 'tomato', 'blight', 0.9, '{}')
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {"id": case_id, "uid": user_id, "oid": object_id},
        )
        session.execute(
            text(
                """
                INSERT INTO plans (id, user_id, object_id, case_id, title, status, version, hash, source, payload, plan_kind, plan_errors)
                VALUES (:id, :uid, :oid, :cid, 'Тестовый план', 'draft', 1, 'hash123', 'ai', :payload, 'PLAN_NEW', :plan_errors)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "id": plan_id,
                "uid": user_id,
                "oid": object_id,
                "cid": case_id,
                "payload": json.dumps({"stages": []}),
                "plan_errors": json.dumps(["needs review"]),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO plan_stages (id, plan_id, title, kind, note, phi_days, meta)
                VALUES (:sid, :pid, 'До цветения', 'season', 'Заметка', 7, :meta)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "sid": stage_id,
                "pid": plan_id,
                "meta": json.dumps({"trigger": "до распускания"}),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO stage_options (id, stage_id, product, ai, dose_value, dose_unit, method, meta, is_selected)
                VALUES (:oid, :sid, 'Фунгицид', 'propiconazole', 0.5, 'л/га', 'опрыскивание', :meta, TRUE)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "oid": option_id,
                "sid": stage_id,
                "meta": json.dumps({"needs_review": False, "product_code": "FUNGI-1"}),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO stage_options (id, stage_id, product, ai, dose_value, dose_unit, method, meta, is_selected)
                VALUES (:oid, :sid, 'Алирин', 'bacillus', 1.0, 'таб', 'опрыскивание', :meta, FALSE)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "oid": option_id + 1,
                "sid": stage_id,
                "meta": json.dumps({"needs_review": True, "product_code": "ALT-2"}),
            },
        )
        session.execute(
            text(
                """
                INSERT INTO events (id, user_id, plan_id, stage_id, stage_option_id, type, due_at, slot_end, status, reason)
                VALUES (:eid, :uid, :pid, :sid, :option_id, 'treatment', '2025-04-12T17:00:00', '2025-04-12T18:00:00', 'scheduled', 'без дождя')
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "eid": 9701,
                "uid": user_id,
                "pid": plan_id,
                "sid": stage_id,
                "option_id": option_id,
            },
        )
        session.commit()
    return {
        "user_id": user_id,
        "plan_id": plan_id,
        "stage_id": stage_id,
        "option_id": option_id,
    }


@pytest.fixture
def plan_fixture():
    return insert_plan_fixture()


def auth_headers(
    method: str, path: str, user_id: int, *, body: object | None = None
) -> dict[str, str]:
    return build_auth_headers(
        method, path, user_id=user_id, api_key="test-api-key", body=body
    )


def test_get_plan_returns_structure(client, plan_fixture):
    resp = client.get(
        f"/v1/plans/{plan_fixture['plan_id']}",
        headers=auth_headers(
            "GET",
            f"/v1/plans/{plan_fixture['plan_id']}",
            plan_fixture["user_id"],
        ),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["plan_id"] == plan_fixture["plan_id"]
    assert len(data["stages"]) == 1
    assert data["stages"][0]["kind"] == "season"
    option = data["stages"][0]["options"][0]
    assert option["product_name"] == "Фунгицид"
    assert option["needs_review"] is False
    assert data["events"][0]["reason"] == "без дождя"


def test_select_option_updates_choice(client, plan_fixture):
    new_option_id = plan_fixture["option_id"] + 1
    resp = client.post(
        f"/v1/plans/{plan_fixture['plan_id']}/select-option",
        headers=auth_headers(
            "POST",
            f"/v1/plans/{plan_fixture['plan_id']}/select-option",
            plan_fixture["user_id"],
            body={"stage_option_id": new_option_id},
        ),
        json={"stage_option_id": new_option_id},
    )
    assert resp.status_code == 200
    data = resp.json()
    opts = data["stages"][0]["options"]
    assert any(o["id"] == new_option_id and o["is_selected"] for o in opts)


def test_accept_plan_updates_status(client, plan_fixture):
    resp = client.post(
        f"/v1/plans/{plan_fixture['plan_id']}/accept",
        headers=auth_headers(
            "POST",
            f"/v1/plans/{plan_fixture['plan_id']}/accept",
            plan_fixture["user_id"],
            body={"stage_option_ids": [plan_fixture["option_id"]]},
        ),
        json={"stage_option_ids": [plan_fixture["option_id"]]},
    )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "accepted"
    assert payload["scheduled_event_ids"]


def test_reject_plan(client, plan_fixture):
    resp = client.post(
        f"/v1/plans/{plan_fixture['plan_id']}/reject",
        headers=auth_headers(
            "POST",
            f"/v1/plans/{plan_fixture['plan_id']}/reject",
            plan_fixture["user_id"],
        ),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"
