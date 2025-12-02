from __future__ import annotations

import os

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "101",
}


def test_assistant_chat_returns_proposal(client):
    resp = client.post(
        "/v1/assistant/chat",
        headers=HEADERS,
        json={"message": "Нужен план для томатов", "object_id": 1},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["assistant_message"]
    assert data["proposals"]
    proposal = data["proposals"][0]
    assert proposal["kind"] == "plan"
    assert proposal["proposal_id"]


def test_assistant_confirm_success(client):
    # создаём объект для пользователя 101
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
            {"oid": 2, "uid": 101},
        )
        session.commit()

    chat_resp = client.post(
        "/v1/assistant/chat",
        headers=HEADERS,
        json={"message": "Зафиксируй обработку завтра", "object_id": 2},
    )
    proposal_id = chat_resp.json()["proposals"][0]["proposal_id"]

    confirm = client.post(
        "/v1/assistant/confirm_plan",
        headers=HEADERS,
        json={"proposal_id": proposal_id, "object_id": 2},
    )
    assert confirm.status_code == 200
    body = confirm.json()
    assert body["status"] == "accepted"
    assert body["plan_id"]
    assert body["event_ids"] or body["reminder_ids"]


def test_assistant_confirm_not_found(client):
    resp = client.post(
        "/v1/assistant/confirm_plan",
        headers=HEADERS,
        json={"proposal_id": "missing", "object_id": 1},
    )
    assert resp.status_code == 404
