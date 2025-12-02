"""Lightweight plan persistence helpers used by assistant.

Цель: не дублировать ORM, но сохранить планы/стадии/опции/события в БД,
совместимо с SQLite (тесты) и PostgreSQL (prod).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import text

from app.db import SessionLocal, engine as db_engine
from app.services.plan_payload import PlanNormalizationResult


class StageCreateResult:
    def __init__(self, stage_id: int | None, option_ids: list[int]):
        self.stage_id = stage_id
        self.option_ids = option_ids


class PlanCreateResult:
    def __init__(self, plan_id: int | None, stages: list[StageCreateResult]):
        self.plan_id = plan_id
        self.stages = stages


def has_valid_options(normalized: PlanNormalizationResult | None) -> bool:
    """Проверка, что в нормализованном плане есть хотя бы одна опция."""
    if not normalized or not normalized.plan or not normalized.plan.stages:
        return False
    for stage in normalized.plan.stages:
        if stage.options:
            return True
    return False
logger = logging.getLogger(__name__)


def is_object_owned(user_id: int, object_id: int) -> bool:
    """Проверка принадлежности object_id пользователю."""
    with SessionLocal() as session:
        result = session.execute(
            text("SELECT 1 FROM objects WHERE id=:oid AND user_id=:uid"),
            {"oid": object_id, "uid": user_id},
        ).fetchone()
    return bool(result)


def _insert_with_id(session, query: str, params: dict[str, Any]) -> int | None:
    """Вставка с возвратом id для sqlite/postgres."""
    if db_engine is not None and db_engine.dialect.name != "sqlite":
        result = session.execute(text(query + " RETURNING id"), params)
        row = result.fetchone()
        return int(row[0]) if row else None
    session.execute(text(query), params)
    return session.execute(text("SELECT last_insert_rowid()")).scalar()


def create_plan_from_payload(
    user_id: int,
    object_id: int,
    normalized: PlanNormalizationResult | None,
    raw_payload: dict[str, Any] | None,
) -> PlanCreateResult:
    """Создать план + стадии/опции. Возвращает PlanCreateResult."""
    with SessionLocal() as session:
        plan_json = json.dumps(normalized.data if normalized else raw_payload or {})
        plan_errors_json = json.dumps(normalized.errors if normalized else [])
        plan_title = normalized.plan.stages[0].name if normalized else "План ассистента"
        plan_kind = normalized.plan.kind if normalized else "PLAN_NEW"
        plan_hash = normalized.plan_hash if normalized else None

        plan_id = _insert_with_id(
            session,
            """
            INSERT INTO plans (user_id, object_id, case_id, title, status, version, hash, source, payload, plan_kind, plan_errors)
            VALUES (:uid, :oid, NULL, :title, 'accepted', 1, :hash, 'assistant', :payload, :kind, :errors)
            """,
            {
                "uid": user_id,
                "oid": object_id,
                "title": plan_title,
                "hash": plan_hash,
                "payload": plan_json,
                "kind": plan_kind,
                "errors": plan_errors_json,
            },
        )
        stages: list[StageCreateResult] = []
        if normalized and plan_id is not None:
            for stage in normalized.plan.stages:
                stage_id = _insert_with_id(
                    session,
                    """
                    INSERT INTO plan_stages (plan_id, title, kind, note, phi_days, meta)
                    VALUES (:pid, :title, :kind, :note, :phi_days, :meta)
                    """,
                    {
                        "pid": plan_id,
                        "title": stage.name,
                        "kind": stage.trigger or "custom",
                        "note": stage.notes,
                        "phi_days": stage.options[0].phi_days if stage.options else None,
                        "meta": json.dumps({"trigger": stage.trigger} if stage.trigger else {}),
                    },
                )
                option_ids: list[int] = []
                if stage.options and stage_id:
                    for idx, opt in enumerate(stage.options):
                        opt_id = _insert_with_id(
                            session,
                            """
                            INSERT INTO stage_options (stage_id, product, ai, dose_value, dose_unit, method, meta, is_selected)
                            VALUES (:sid, :product, :ai, :dose_value, :dose_unit, :method, :meta, :selected)
                            """,
                            {
                                "sid": stage_id,
                                "product": opt.product_name,
                                "ai": opt.ai,
                                "dose_value": opt.dose_value,
                                "dose_unit": opt.dose_unit,
                                "method": opt.method,
                                "meta": json.dumps(
                                    {"needs_review": opt.needs_review, "product_code": opt.product_code}
                                ),
                                "selected": idx == 0,
                            },
                        )
                        if opt_id is not None:
                            option_ids.append(opt_id)
                stages.append(StageCreateResult(stage_id=stage_id, option_ids=option_ids))
        session.commit()
        return PlanCreateResult(plan_id=plan_id, stages=stages)


def _normalize_dt(dt_str: str | None):
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(dt_str)
    except Exception:
        return None


def create_event_with_reminder(
    user_id: int,
    plan_id: int,
    stage_id: int,
    stage_option_id: int | None = None,
    due_at_iso: str | None = None,
    slot_end_iso: str | None = None,
    reason: str = "Assistant",
    source: str = "assistant",
    channel: str = "telegram",
) -> tuple[list[int], list[int]]:
    """Создать событие и опционально напоминание (T-30 минут)."""
    due_at_dt = _normalize_dt(due_at_iso) or (datetime.now(timezone.utc) + timedelta(hours=1))
    slot_end_dt = _normalize_dt(slot_end_iso) or (due_at_dt + timedelta(hours=1))
    with SessionLocal() as session:
        try:
            event_id = _insert_with_id(
                session,
                """
                INSERT INTO events (user_id, plan_id, stage_id, stage_option_id, type, due_at, slot_end, status, reason, source)
                VALUES (:uid, :pid, :sid, :opt_id, 'treatment', :due_at, :slot_end, 'scheduled', :reason, :source)
                """,
                {
                    "uid": user_id,
                    "pid": plan_id,
                    "sid": stage_id,
                    "opt_id": stage_option_id,
                    "due_at": due_at_dt.isoformat(),
                    "slot_end": slot_end_dt.isoformat(),
                    "reason": reason,
                    "source": source,
                },
            )
            reminder_ids: list[int] = []
            if event_id:
                reminder_id = _insert_with_id(
                    session,
                    """
                    INSERT INTO reminders (user_id, event_id, fire_at, channel, status, payload)
                    VALUES (:uid, :eid, :fire_at, :channel, 'pending', :payload)
                    """,
                    {
                        "uid": user_id,
                        "eid": event_id,
                        "fire_at": (due_at_dt - timedelta(minutes=30)).isoformat(),
                        "channel": channel,
                        "payload": json.dumps({"kind": "assistant_stub"}),
                    },
                )
                if reminder_id:
                    reminder_ids.append(reminder_id)
            session.commit()
            return [event_id] if event_id else [], reminder_ids
        except Exception as exc:  # pragma: no cover - при отсутствии таблиц
            logger.debug("Could not create event/reminder: %s", exc)
            return [], []


def enqueue_autoplan(
    user_id: int,
    plan_id: int,
    stage_id: int,
    stage_option_id: int,
    min_hours_ahead: int = 2,
    horizon_hours: int = 72,
) -> int | None:
    """Создать запись автоплана (pending) для воркера."""
    with SessionLocal() as session:
        try:
            run_id = _insert_with_id(
                session,
                """
                INSERT INTO autoplan_runs (user_id, plan_id, stage_id, stage_option_id, status, min_hours_ahead, horizon_hours)
                VALUES (:uid, :pid, :sid, :soid, 'pending', :min_h, :horizon)
                """,
                {
                    "uid": user_id,
                    "pid": plan_id,
                    "sid": stage_id,
                    "soid": stage_option_id,
                    "min_h": min_hours_ahead,
                    "horizon": horizon_hours,
                },
            )
            session.commit()
            return run_id
        except Exception as exc:  # pragma: no cover
            logger.debug("Could not enqueue autoplan: %s", exc)
            return None
