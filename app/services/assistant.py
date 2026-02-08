"""Conversational assistant orchestration helpers (beta/stub).

Чат — интерфейс; данные остаются в структурах cases/plans/events.
Сервис хранит предложенные действия в Redis для последующего подтверждения.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import HTTPException
from prometheus_client import Counter
from redis.exceptions import RedisError
from sqlalchemy import text

from app.db import SessionLocal
from app.dependencies import ErrorResponse, redis_client
from app.models import ErrorCode

logger = logging.getLogger(__name__)

PROPOSAL_TTL_SECONDS = 60 * 60  # 1 час
proposal_metric = Counter(
    "assistant_proposals_total",
    "Assistant proposals lifecycle counter",
    ["status"],
)


def _make_redis_key(proposal_id: str) -> str:
    return f"assistant:proposal:{proposal_id}"


async def save_proposal(
    user_id: int,
    object_id: int | None,
    proposal: dict[str, Any],
) -> None:
    """Сохранить предложение ассистента в Redis для подтверждения."""
    proposal_id = proposal.get("proposal_id")
    if not proposal_id:
        raise ValueError("proposal_id is required")
    record = {
        "proposal_id": proposal_id,
        "user_id": user_id,
        "object_id": object_id,
        "payload": proposal,
    }
    try:
        await asyncio.to_thread(_persist_proposal_db, record)
    except Exception as exc:
        logger.exception("assistant_proposal_db_store_failed: %s", exc)
    proposal_metric.labels(status="pending").inc()
    try:
        await redis_client.setex(
            _make_redis_key(proposal_id),
            PROPOSAL_TTL_SECONDS,
            json.dumps(record),
        )
    except RedisError as exc:
        logger.exception("Failed to persist assistant proposal: %s", exc)
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE,
            message="Assistant storage unavailable",
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc


async def fetch_proposal(proposal_id: str) -> dict[str, Any] | None:
    """Вернуть сохранённое предложение ассистента."""
    try:
        raw = await redis_client.get(_make_redis_key(proposal_id))
    except RedisError as exc:
        logger.exception("Failed to fetch assistant proposal: %s", exc)
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE,
            message="Assistant storage unavailable",
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Corrupted proposal payload for %s", proposal_id)
    db_record = await asyncio.to_thread(_fetch_proposal_from_db, proposal_id)
    return db_record


async def delete_proposal(proposal_id: str) -> None:
    try:
        await redis_client.delete(_make_redis_key(proposal_id))
    except RedisError as exc:
        logger.exception("Failed to delete assistant proposal: %s", exc)


async def set_proposal_status(
    proposal_id: str,
    status: str,
    *,
    plan_id: int | None = None,
    event_ids: list[int] | None = None,
    reminder_ids: list[int] | None = None,
    error_code: str | None = None,
) -> None:
    await asyncio.to_thread(
        _update_proposal_status,
        proposal_id,
        status,
        plan_id,
        event_ids or [],
        reminder_ids or [],
        error_code,
    )
    proposal_metric.labels(status=status).inc()


def build_default_proposal(message: str, object_id: int | None) -> dict[str, Any]:
    """Сконструировать простое предложение для фиксации, чтобы бот мог тестировать кнопку."""
    proposal_id = str(uuid.uuid4())
    plan_payload = {
        "kind": "PLAN_NEW",
        "object_hint": None,
        "diagnosis": None,
        "stages": [
            {
                "name": "Обработка",
                "trigger": "после согласования",
                "notes": f"Черновик из живого чата: «{message[:80]}»",
                "options": [
                    {
                        "product_name": "Уточнить препарат",
                        "dose": "уточнить дозу и метод",
                        "needs_review": True,
                    }
                ],
            }
        ],
    }
    return {
        "proposal_id": proposal_id,
        "kind": "plan",
        "plan_payload": plan_payload,
        "suggested_actions": ["pin", "ask_clarification", "show_plans"],
        "object_id": object_id,
    }


def build_default_answer(message: str) -> str:
    """Базовый ответ ассистента, подчёркивающий правило «чат = интерфейс»."""
    return (
        "Понял запрос: «{msg}». "
        "Я могу обсудить варианты и предложить черновик плана. "
        "Чтобы зафиксировать в дневнике, нажми «📌 Зафиксировать»."
    ).format(msg=message.strip())


def _persist_proposal_db(record: dict[str, Any]) -> None:
    payload_json = json.dumps(record["payload"])
    with SessionLocal() as session:
        payload_expr = _json_param(session, "payload")
        empty_expr = _json_param(session, "empty_json")
        sql = text(
            f"""
            INSERT INTO assistant_proposals (proposal_id, user_id, object_id, payload, status)
            VALUES (:pid, :uid, :oid, {payload_expr}, 'pending')
            ON CONFLICT (proposal_id)
            DO UPDATE SET
                user_id = EXCLUDED.user_id,
                object_id = EXCLUDED.object_id,
                payload = EXCLUDED.payload,
                status = 'pending',
                plan_id = NULL,
                event_ids = {empty_expr},
                reminder_ids = {empty_expr},
                error_code = NULL,
                confirmed_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            """
        )
        session.execute(
            sql,
            {
                "pid": record["proposal_id"],
                "uid": record["user_id"],
                "oid": record["object_id"],
                "payload": payload_json,
                "empty_json": json.dumps([]),
            },
        )
        session.commit()


def _fetch_proposal_from_db(proposal_id: str) -> dict[str, Any] | None:
    with SessionLocal() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT proposal_id, user_id, object_id, payload
                    FROM assistant_proposals
                    WHERE proposal_id=:pid
                    """
                ),
                {"pid": proposal_id},
            )
            .mappings()
            .first()
        )
        if not row:
            return None
        payload = row["payload"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = {}
        return {
            "proposal_id": row["proposal_id"],
            "user_id": row["user_id"],
            "object_id": row["object_id"],
            "payload": payload,
        }


def _update_proposal_status(
    proposal_id: str,
    status: str,
    plan_id: int | None,
    event_ids: list[int],
    reminder_ids: list[int],
    error_code: str | None,
) -> None:
    with SessionLocal() as session:
        event_expr = _json_param(session, "event_ids")
        reminder_expr = _json_param(session, "reminder_ids")
        session.execute(
            text(
                f"""
                UPDATE assistant_proposals
                SET
                    status = :status,
                    plan_id = :plan_id,
                    event_ids = {event_expr},
                    reminder_ids = {reminder_expr},
                    error_code = :error_code,
                    confirmed_at = CASE WHEN :status = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE proposal_id = :pid
                """
            ),
            {
                "pid": proposal_id,
                "status": status,
                "plan_id": plan_id,
                "event_ids": json.dumps(event_ids),
                "reminder_ids": json.dumps(reminder_ids),
                "error_code": error_code,
            },
        )
        session.commit()


def _json_param(session, name: str) -> str:
    return f":{name}"
