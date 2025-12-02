"""Conversational assistant orchestration helpers (beta/stub).

Чат — интерфейс; данные остаются в структурах cases/plans/events.
Сервис хранит предложенные действия в Redis для последующего подтверждения.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import HTTPException
from redis.exceptions import RedisError

from app.dependencies import ErrorResponse, redis_client
from app.models import ErrorCode

logger = logging.getLogger(__name__)

PROPOSAL_TTL_SECONDS = 60 * 60  # 1 час


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
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Corrupted proposal payload for %s", proposal_id)
        return None


async def delete_proposal(proposal_id: str) -> None:
    try:
        await redis_client.delete(_make_redis_key(proposal_id))
    except RedisError as exc:
        logger.exception("Failed to delete assistant proposal: %s", exc)


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
