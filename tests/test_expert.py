from __future__ import annotations
import os
from app.db import SessionLocal
from app.models import Event

HEADERS = {
    "X-API-Key": os.getenv("API_KEY", "test-api-key"),
    "X-API-Ver": "v1",
    "X-User-ID": "1",
}


def test_ask_expert_success(client):
    with SessionLocal() as session:
        before = session.query(Event).filter_by(user_id=1, event="ask_expert").count()

    resp = client.post(
        "/v1/ask_expert",
        headers=HEADERS,
        json={"question": "как бороться с вредителями?"},
    )
    assert resp.status_code == 202
    assert resp.json() == {"status": "queued"}

    with SessionLocal() as session:
        after = session.query(Event).filter_by(user_id=1, event="ask_expert").count()
    assert after == before + 1


def test_ask_expert_missing_header(client):
    resp = client.post(
        "/v1/ask_expert",
        headers={"X-API-Key": "test-api-key", "X-API-Ver": "v1"},
        json={"question": "q"},
    )
    assert resp.status_code == 401


def test_ask_expert_empty_question(client):
    resp = client.post(
        "/v1/ask_expert",
        headers=HEADERS,
        json={"question": ""},
    )
    assert resp.status_code == 400
    assert resp.json() == {
        "code": "BAD_REQUEST",
        "message": "Invalid request body",
    }
    assert "detail" not in resp.json()


def test_ask_expert_too_long_question(client):
    resp = client.post(
        "/v1/ask_expert",
        headers=HEADERS,
        json={"question": "a" * 501},
    )
    assert resp.status_code == 400
    assert resp.json() == {
        "code": "BAD_REQUEST",
        "message": "Invalid request body",
    }
    assert "detail" not in resp.json()


def test_ask_expert_invalid_json(client):
    resp = client.post(
        "/v1/ask_expert",
        headers={**HEADERS, "Content-Type": "application/json"},
        content="not json",
    )
    assert resp.status_code == 400
    assert resp.json() == {
        "code": "BAD_REQUEST",
        "message": "Invalid JSON payload",
    }
    assert "detail" not in resp.json()