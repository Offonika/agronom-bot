"""Assistant orchestrator: собирает контекст и готовит предложения."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from app.db import SessionLocal

logger = logging.getLogger(__name__)


@dataclass
class AssistantContext:
    user_id: int
    object_id: int | None
    objects: list[dict[str, Any]]
    recent_diagnosis: dict[str, Any] | None
    latest_plan: dict[str, Any] | None
    latest_events: list[dict[str, Any]]


def load_context(user_id: int, object_id: int | None) -> AssistantContext:
    with SessionLocal() as session:
        objects = []
        if object_id is not None:
            rows = session.execute(
                text(
                    "SELECT id, name, meta FROM objects WHERE user_id=:uid AND id=:oid"
                ),
                {"uid": user_id, "oid": object_id},
            ).mappings()
            objects = [dict(row) for row in rows]

        recent_diagnosis = None
        try:
            recent_diag = session.execute(
                text(
                    """
                    SELECT id, object_id, payload, created_at
                    FROM recent_diagnoses
                    WHERE user_id=:uid
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"uid": user_id},
            ).mappings().first()
            recent_diagnosis = dict(recent_diag) if recent_diag else None
        except Exception as exc:  # pragma: no cover - sqlite test schema may differ
            logger.debug("recent_diagnoses not available: %s", exc)

        latest_plan_dict = None
        try:
            latest_plan = session.execute(
                text(
                    """
                    SELECT id, object_id, status, payload, plan_kind, plan_errors
                    FROM plans
                    WHERE user_id=:uid
                    ORDER BY id DESC
                    LIMIT 1
                    """
                ),
                {"uid": user_id},
            ).mappings().first()
            latest_plan_dict = dict(latest_plan) if latest_plan else None
        except Exception as exc:  # pragma: no cover
            logger.debug("plans not available: %s", exc)

        latest_events_list: list[dict[str, Any]] = []
        try:
            latest_events = session.execute(
                text(
                    """
                    SELECT id, plan_id, stage_id, stage_option_id, type, due_at, status, reason
                    FROM events
                    WHERE user_id=:uid
                    ORDER BY due_at DESC
                    LIMIT 5
                    """
                ),
                {"uid": user_id},
            ).mappings()
            latest_events_list = [dict(row) for row in latest_events]
        except Exception as exc:  # pragma: no cover
            logger.debug("events not available: %s", exc)

    return AssistantContext(
        user_id=user_id,
        object_id=object_id,
        objects=objects,
        recent_diagnosis=recent_diagnosis,
        latest_plan=latest_plan_dict,
        latest_events=latest_events_list,
    )


def build_response(
    message: str,
    ctx: AssistantContext,
) -> tuple[str, list[dict[str, Any]]]:
    """Сконструировать ответ ассистента и список предложений.

    Сейчас предложения простые, но используют контекст (объект/последний диагноз),
    чтобы текст и заметки были осмысленными.
    """
    object_note = ""
    if ctx.object_id:
        object_note = f" для объекта {ctx.object_id}"
    if ctx.recent_diagnosis and ctx.recent_diagnosis.get("payload"):
        object_note += " (учёл последний диагноз)"
    answer = (
        f"Я учёл твой запрос{object_note} и могу подготовить черновик плана. "
        "Нажми «📌 Зафиксировать», чтобы записать в дневник."
    )
    proposals: list[dict[str, Any]] = []
    proposal = {
        "proposal_id": None,  # заполнится в assistant_service
        "kind": "plan",
        "plan_payload": {
            "kind": "PLAN_NEW",
            "object_hint": None,
            "diagnosis": None,
            "stages": [
                {
                    "name": "Обработка",
                    "trigger": "по согласованию",
                    "notes": f"Черновик из чата: «{message[:80]}»",
                    "options": [
                        {
                            "product_name": "Уточнить препарат",
                            "dose": "уточнить дозу и метод",
                            "needs_review": True,
                        }
                    ],
                }
            ],
        },
        "suggested_actions": ["pin", "ask_clarification", "show_plans"],
        "object_id": ctx.object_id,
    }
    proposals.append(proposal)
    return answer, proposals
