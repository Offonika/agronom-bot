"""Assistant orchestrator: собирает контекст и готовит предложения."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from app.db import SessionLocal
from app.services import assistant as assistant_service
from app.services import assistant_llm
from app.services import knowledge_rag

logger = logging.getLogger(__name__)

_PLAN_ID_CTA_RE = re.compile(r"📋\s*Открыть\s+план\s*#\d+", re.IGNORECASE)
_FOLLOWUPS_TITLE_RE = re.compile(r"^\s*можно\s+спросить[:\s]*$", re.IGNORECASE)
_ACK_GENDER_RE = re.compile(r"\bПонял\([аa]\)\b", re.IGNORECASE)
_CHEMISTRY_QUERY_RE = re.compile(
    r"(фунгицид|инсектицид|мед[ьи]|медн|хими|препарат|обработ)",
    re.IGNORECASE,
)
_CHEMISTRY_LINE_RE = re.compile(r"(фунгицид|инсектицид|мед[ьи]|медн|хими)", re.IGNORECASE)
_FORMAL_REPLACEMENTS = (
    (re.compile(r"\bты\b", re.IGNORECASE), "Вы"),
    (re.compile(r"\bтебе\b", re.IGNORECASE), "Вам"),
    (re.compile(r"\bтебя\b", re.IGNORECASE), "Вас"),
    (re.compile(r"\bтобой\b", re.IGNORECASE), "Вами"),
    (re.compile(r"\bтвой\b", re.IGNORECASE), "Ваш"),
    (re.compile(r"\bтвоя\b", re.IGNORECASE), "Ваша"),
    (re.compile(r"\bтвое\b", re.IGNORECASE), "Ваше"),
    (re.compile(r"\bтвоё\b", re.IGNORECASE), "Ваше"),
    (re.compile(r"\bтвои\b", re.IGNORECASE), "Ваши"),
)


@dataclass
class AssistantContext:
    user_id: int
    object_id: int | None
    objects: list[dict[str, Any]]
    recent_diagnosis: dict[str, Any] | None
    latest_plan: dict[str, Any] | None
    latest_events: list[dict[str, Any]]
    dialog_history: list[dict[str, str]]


def load_context(
    user_id: int,
    object_id: int | None,
    dialog_history: list[dict[str, Any]] | None = None,
) -> AssistantContext:
    with SessionLocal() as session:
        objects = _fetch_objects(session, user_id, object_id)
        recent_diag = _fetch_recent_diagnosis(session, user_id, object_id)
        latest_plan = _fetch_plan(session, user_id, object_id)
        latest_events = _fetch_events(session, user_id, latest_plan)

    return AssistantContext(
        user_id=user_id,
        object_id=object_id,
        objects=objects,
        recent_diagnosis=recent_diag,
        latest_plan=latest_plan,
        latest_events=latest_events,
        dialog_history=_normalize_dialog_history(dialog_history),
    )


def _normalize_dialog_history(dialog_history: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    if not isinstance(dialog_history, list) or not dialog_history:
        return []
    normalized: list[dict[str, str]] = []
    for item in dialog_history:
        if not isinstance(item, dict):
            continue
        role_raw = str(item.get("role") or "").strip().lower()
        if role_raw not in {"user", "assistant"}:
            continue
        text_raw = str(item.get("text") or "").strip()
        if not text_raw:
            continue
        normalized.append(
            {
                "role": role_raw,
                "text": text_raw[:1000],
            }
        )
    if len(normalized) > 24:
        return normalized[-24:]
    return normalized


def build_response(
    message: str,
    ctx: AssistantContext,
) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Собрать текст ответа, follow-ups и список предложений."""

    object_label = _format_object_label(ctx)
    plan = _plan_matches_context(ctx.latest_plan, ctx.object_id)

    proposals: list[dict[str, Any]] = []
    if plan:
        intent = _detect_intent(message)
        custom_plan = _respond_with_plan_intent(intent, plan, ctx.latest_events, object_label, message)
        if custom_plan:
            answer, followups = custom_plan[0], custom_plan[1]
            return _maybe_use_llm(answer, followups, proposals, message, ctx, object_label)
        answer = _describe_existing_plan(plan, ctx.latest_events, object_label)
        followups = [
            "Нужно перенести или отменить ближайшую обработку?",
            "Добавить напоминание или поменять препарат?",
        ]
        return _maybe_use_llm(answer, followups, proposals, message, ctx, object_label)

    diag_record = _extract_diagnosis_record(ctx.recent_diagnosis, ctx.object_id)
    if diag_record:
        answer, followups = _describe_recent_diagnosis(diag_record, object_label)
        plan_payload = _plan_payload_from_diagnosis(diag_record)
        if plan_payload:
            proposal = _build_plan_proposal(plan_payload, ctx.object_id)
            proposals = [proposal]
        return _maybe_use_llm(answer, followups, proposals, message, ctx, object_label)

    fallback_answer = (
        f"Пока у меня нет свежего диагноза для {object_label}. "
        "Могу сохранить черновик из нашего диалога или мы можем начать с нового фото."
    )
    fallback_proposal = assistant_service.build_default_proposal(message, ctx.object_id)
    followups = [
        "Расскажешь подробнее о симптомах?",
        "Хочешь, чтобы я записал это как план?",
    ]
    proposals = [fallback_proposal]
    return _maybe_use_llm(fallback_answer, followups, proposals, message, ctx, object_label)


def _maybe_use_llm(
    answer: str,
    followups: list[str],
    proposals: list[dict[str, Any]],
    message: str,
    ctx: AssistantContext,
    object_label: str,
) -> tuple[str, list[dict[str, Any]], list[str]]:
    if not _llm_enabled():
        clean_answer, clean_followups = _finalize_assistant_text(
            answer,
            followups,
            user_message=message,
        )
        return clean_answer, proposals, clean_followups
    try:
        context = _build_llm_context(
            ctx,
            object_label,
            answer,
            followups,
            proposals,
            user_message=message,
        )
        llm_answer, llm_followups = assistant_llm.build_llm_response(message, context)
        final_answer, final_followups = _finalize_assistant_text(
            llm_answer or answer,
            llm_followups or followups,
            user_message=message,
        )
        return final_answer, proposals, final_followups
    except Exception as exc:  # pragma: no cover - network/SDK errors
        logger.warning("assistant_llm_failed: %s", exc)
        clean_answer, clean_followups = _finalize_assistant_text(
            answer,
            followups,
            user_message=message,
        )
        return clean_answer, proposals, clean_followups


def _llm_enabled() -> bool:
    return assistant_llm.llm_enabled()


def _build_llm_context(
    ctx: AssistantContext,
    object_label: str,
    answer: str,
    followups: list[str],
    proposals: list[dict[str, Any]],
    *,
    user_message: str,
) -> dict[str, Any]:
    plan = _plan_matches_context(ctx.latest_plan, ctx.object_id)
    stage_lines = []
    if plan:
        stages = _extract_plan_stages(plan.get("payload"))
        if not stages and plan.get("stages"):
            stages = plan["stages"]
        stage_lines = [_format_stage_line(stage) for stage in stages[:3] if stage]
    upcoming = _pick_upcoming_event(ctx.latest_events or [])
    diag_record = _extract_diagnosis_record(ctx.recent_diagnosis, ctx.object_id)
    diagnosis = None
    if diag_record:
        payload = _coerce_diagnosis_payload(diag_record)
        diagnosis = {
            "disease": payload.get("disease_name_ru") or payload.get("disease"),
            "crop": payload.get("crop_ru") or payload.get("crop"),
            "treatment": payload.get("treatment_plan") or None,
            "next_steps": payload.get("next_steps") or None,
        }
    ctas: list[str] = []
    if plan and plan.get("id"):
        ctas.append("📋 Открыть план")
        ctas.append("📋 Показать дневник")
    if any(
        "pin" in (proposal.get("suggested_actions") or []) for proposal in (proposals or [])
    ):
        ctas.append("📌 Зафиксировать")
    knowledge = knowledge_rag.build_llm_knowledge_context(user_message)
    return {
        "object_label": object_label,
        "plan": {
            "id": plan.get("id") if plan else None,
            "title": plan.get("title") if plan else None,
            "stages": stage_lines,
            "upcoming": {
                "stage": upcoming.get("stage_title") if upcoming else None,
                "due_at": upcoming.get("due_at") if upcoming else None,
            }
            if upcoming
            else None,
        }
        if plan
        else None,
        "recent_diagnosis": diagnosis,
        "available_ctas": ctas,
        "dialog_history": ctx.dialog_history or None,
        "knowledge_rag": knowledge or None,
        "fallback_answer": answer,
        "fallback_followups": followups,
    }


def _finalize_assistant_text(
    answer: str,
    followups: list[str],
    *,
    user_message: str = "",
) -> tuple[str, list[str]]:
    allow_chemistry = _chemistry_requested(user_message)
    clean_answer = _normalize_text_line(answer, allow_chemistry=allow_chemistry)
    clean_followups: list[str] = []
    seen: set[str] = set()
    for item in followups or []:
        line = _normalize_text_line(item, allow_chemistry=allow_chemistry)
        if not line or _FOLLOWUPS_TITLE_RE.match(line):
            continue
        line = line.rstrip(".;:").strip()
        if line and not line.endswith("?"):
            line = f"{line}?"
        key = line.casefold()
        if key in seen:
            continue
        seen.add(key)
        clean_followups.append(line)
    return clean_answer, clean_followups[:3]


def _chemistry_requested(user_message: str | None) -> bool:
    if not user_message:
        return False
    return bool(_CHEMISTRY_QUERY_RE.search(str(user_message)))


def _normalize_text_line(text: str | None, *, allow_chemistry: bool) -> str:
    if not text:
        return ""
    value = str(text).strip()
    if not value:
        return ""
    value = _PLAN_ID_CTA_RE.sub("📋 Открыть план", value)
    value = _ACK_GENDER_RE.sub("Понял", value)
    value = value.replace("влажной салфеткой", "чистой влажной тканью")
    for pattern, replacement in _FORMAL_REPLACEMENTS:
        value = pattern.sub(replacement, value)
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not lines:
        return ""

    followups_idx = None
    for idx, line in enumerate(lines):
        if _FOLLOWUPS_TITLE_RE.match(line):
            followups_idx = idx
            break
    if followups_idx is not None:
        lines = lines[:followups_idx]

    if not allow_chemistry:
        lines = [line for line in lines if not _CHEMISTRY_LINE_RE.search(line)]

    return "\n".join(lines).strip()


def _fetch_objects(session, user_id: int, object_id: int | None) -> list[dict[str, Any]]:
    params = {"uid": user_id}
    sql = "SELECT id, name, meta FROM objects WHERE user_id=:uid"
    if object_id is not None:
        sql += " AND id=:oid"
        params["oid"] = object_id
    sql += " ORDER BY id DESC LIMIT 5"
    rows = session.execute(text(sql), params).mappings()
    return [dict(row) for row in rows]


def _fetch_recent_diagnosis(session, user_id: int, object_id: int | None) -> dict[str, Any] | None:
    base_query = """
        SELECT id, object_id, diagnosis_payload, created_at
        FROM recent_diagnoses
        WHERE user_id=:uid {filter}
        ORDER BY created_at DESC
        LIMIT 1
    """
    params: dict[str, Any] = {"uid": user_id}
    filter_clause = ""
    if object_id is not None:
        filter_clause = "AND object_id=:oid"
        params["oid"] = object_id
    try:
        record = (
            session.execute(text(base_query.format(filter=filter_clause)), params).mappings().first()
        )
        if record:
            return dict(record)
        if filter_clause:
            record = (
                session.execute(text(base_query.format(filter="")), {"uid": user_id}).mappings().first()
            )
            return dict(record) if record else None
    except Exception as exc:  # pragma: no cover
        logger.debug("recent_diagnoses not available: %s", exc)
    return None


def _fetch_plan(session, user_id: int, object_id: int | None) -> dict[str, Any] | None:
    base_query = """
        SELECT id, object_id, status, payload, plan_kind, plan_errors, title
        FROM plans
        WHERE user_id=:uid {filter}
        ORDER BY id DESC
        LIMIT 1
    """
    params: dict[str, Any] = {"uid": user_id}
    clause = ""
    if object_id is not None:
        clause = "AND object_id=:oid"
        params["oid"] = object_id
    try:
        record = session.execute(text(base_query.format(filter=clause)), params).mappings().first()
        if record:
            data = dict(record)
            data["stages"] = _fetch_plan_stages(session, data["id"])
            return data
        if clause:
            record = (
                session.execute(text(base_query.format(filter="")), {"uid": user_id}).mappings().first()
            )
            if record:
                data = dict(record)
                data["stages"] = _fetch_plan_stages(session, data["id"])
                return data
    except Exception as exc:  # pragma: no cover
        logger.debug("plans not available: %s", exc)
    return None


def _fetch_plan_stages(session, plan_id: int | None) -> list[dict[str, Any]]:
    if not plan_id:
        return []
    sql = """
        SELECT
            ps.id,
            ps.title,
            ps.note,
            ps.kind,
            ps.phi_days,
            (
                SELECT product
                FROM stage_options
                WHERE stage_id = ps.id
                ORDER BY CASE WHEN is_selected THEN 0 ELSE 1 END, id
                LIMIT 1
            ) AS product,
            (
                SELECT ai
                FROM stage_options
                WHERE stage_id = ps.id
                ORDER BY CASE WHEN is_selected THEN 0 ELSE 1 END, id
                LIMIT 1
            ) AS ai,
            (
                SELECT dose_value
                FROM stage_options
                WHERE stage_id = ps.id
                ORDER BY CASE WHEN is_selected THEN 0 ELSE 1 END, id
                LIMIT 1
            ) AS dose_value,
            (
                SELECT dose_unit
                FROM stage_options
                WHERE stage_id = ps.id
                ORDER BY CASE WHEN is_selected THEN 0 ELSE 1 END, id
                LIMIT 1
            ) AS dose_unit,
            (
                SELECT method
                FROM stage_options
                WHERE stage_id = ps.id
                ORDER BY CASE WHEN is_selected THEN 0 ELSE 1 END, id
                LIMIT 1
            ) AS method
        FROM plan_stages ps
        WHERE ps.plan_id=:pid
        ORDER BY ps.id ASC
        LIMIT 5
    """
    rows = session.execute(text(sql), {"pid": plan_id}).mappings()
    stages: list[dict[str, Any]] = []
    for row in rows:
        option = {
            "product_name": row.get("product"),
            "ai": row.get("ai"),
            "dose_value": row.get("dose_value"),
            "dose_unit": row.get("dose_unit"),
            "method": row.get("method"),
        }
        stages.append(
            {
                "name": row.get("title"),
                "notes": row.get("note"),
                "kind": row.get("kind"),
                "options": [option] if any(option.values()) else [],
            }
        )
    return stages


def _fetch_events(session, user_id: int, plan: dict[str, Any] | None) -> list[dict[str, Any]]:
    clause = ""
    params: dict[str, Any] = {"uid": user_id}
    if plan:
        clause = "AND e.plan_id=:pid"
        params["pid"] = plan.get("id")
    sql = f"""
        SELECT
            e.id, e.plan_id, e.stage_id, e.stage_option_id, e.type,
            e.due_at, e.status, e.reason, ps.title AS stage_title
        FROM events e
        LEFT JOIN plan_stages ps ON ps.id = e.stage_id
        WHERE e.user_id=:uid {clause}
          AND (e.status IS NULL OR e.status IN ('scheduled', 'pending'))
        ORDER BY e.due_at ASC
        LIMIT 5
    """
    try:
        rows = session.execute(text(sql), params).mappings()
        return [dict(row) for row in rows]
    except Exception as exc:  # pragma: no cover
        logger.debug("events not available: %s", exc)
        return []


def _plan_matches_context(plan: dict[str, Any] | None, object_id: int | None) -> dict[str, Any] | None:
    if not plan:
        return None
    if object_id is None or plan.get("object_id") == object_id:
        return plan
    return None


def _format_object_label(ctx: AssistantContext) -> str:
    if ctx.objects:
        name = ctx.objects[0].get("name")
        if name:
            return f"«{name}»"
    if ctx.object_id:
        return f"объекта #{ctx.object_id}"
    return "растения"


def _describe_existing_plan(plan: dict[str, Any], events: list[dict[str, Any]], object_label: str) -> str:
    stages = _extract_plan_stages(plan.get("payload"))
    if not stages and plan.get("stages"):
        stages = plan["stages"]
    sections: list[str] = []
    stage_lines = [_format_stage_line(stage) for stage in stages[:3] if stage]
    if stage_lines:
        sections.append("Основные обработки:\n" + "\n".join(stage_lines))
    upcoming = _pick_upcoming_event(events)
    if upcoming:
        due_text = _format_due_datetime(upcoming.get("due_at"))
        stage_title = upcoming.get("stage_title") or "обработка"
        sections.append(f"Ближайшая обработка: {stage_title} — {due_text}.")
    else:
        sections.append("Ближайших обработок пока нет — могу подобрать время или настроить напоминание.")
    header = f"План для {object_label} уже сохранён ({len(stages)} этап(ов))."
    footer = "Если нужно внести изменения, скажи или нажми «📋 Показать дневник»."
    return "\n\n".join([header] + sections + [footer])


def _describe_recent_diagnosis(diag_record: dict[str, Any], object_label: str) -> tuple[str, list[str]]:
    payload = _coerce_diagnosis_payload(diag_record)
    crop = payload.get("crop_ru") or payload.get("crop") or object_label
    disease = payload.get("disease_name_ru") or payload.get("disease")
    reasoning = payload.get("reasoning") or []
    treatment = payload.get("treatment_plan") or {}

    parts: list[str] = []
    if disease:
        parts.append(f"Последний диагноз для {object_label or crop} — {disease}.")
    if treatment:
        product = treatment.get("product") or treatment.get("substance") or "обработка"
        dose_parts: list[str] = []
        if treatment.get("dosage_value"):
            dose_parts.append(str(treatment["dosage_value"]))
        if treatment.get("dosage_unit"):
            dose_parts.append(str(treatment["dosage_unit"]))
        method = treatment.get("method")
        treatment_line = f"• {product}"
        if dose_parts:
            treatment_line += f" — {' '.join(dose_parts)}"
        if method:
            treatment_line += f" ({method})"
        parts.append("Рекомендованный шаг:\n" + treatment_line)
    elif reasoning:
        parts.append("Что заметил ассистент:\n- " + "\n- ".join(reasoning[:3]))
    parts.append("Если всё звучит верно, нажми «📌 Зафиксировать» — я сохраню план в дневнике.")

    followups = payload.get("assistant_followups_ru") or [
        "Нужно подобрать другое средство?",
        "Запланировать напоминание по этому диагнозу?",
    ]
    return "\n\n".join(parts), followups


def _extract_plan_stages(raw_payload: Any) -> list[dict[str, Any]]:
    if not raw_payload:
        return []
    if isinstance(raw_payload, str):
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            return []
    elif isinstance(raw_payload, dict):
        payload = raw_payload
    else:
        return []
    stages = payload.get("stages")
    return stages if isinstance(stages, list) else []


def _format_stage_line(stage: dict[str, Any]) -> str | None:
    if not isinstance(stage, dict):
        return None
    name = stage.get("name") or "Этап"
    options = stage.get("options") or []
    option = options[0] if options else {}
    product = option.get("product_name") or option.get("product") or option.get("ai")
    if not product:
        return f"• {name}"
    parts = [product]
    dose = None
    dose_value = option.get("dose_value")
    dose_unit = option.get("dose_unit")
    if isinstance(dose_value, (int, float)):
        dose = f"{dose_value:g}"
    if dose_unit:
        dose = f"{dose or ''} {dose_unit}".strip()
    if dose:
        parts.append(dose)
    method = option.get("method")
    if method:
        parts.append(method)
    return f"• {name}: " + ", ".join(parts)


def _respond_with_plan_intent(
    intent: str | None,
    plan: dict[str, Any],
    events: list[dict[str, Any]],
    object_label: str,
    message: str,
) -> tuple[str, list[str]] | None:
    if not intent:
        return None
    stages = plan.get("stages") or _extract_plan_stages(plan.get("payload"))
    stage_count = len(stages)
    upcoming = _pick_upcoming_event(events)
    default_followups = [
        "Нужно перенести или отменить ближайшую обработку?",
        "Добавить напоминание или поменять препарат?",
    ]

    if intent == "greeting":
        answer = (
            f"Привет! План для {object_label} уже готов ({stage_count} этап(ов)). "
            "Скажи, нужно ли что-то уточнить, перенести или добавить."
        )
        return answer, default_followups

    if intent == "question":
        quoted = _quote_user_message(message)
        answer = (
            f"Ты спрашиваешь: «{quoted}». План для {object_label} уже сохранён. "
            "Если вопрос про изменения, напиши, что скорректировать. "
            "Если появилась новая проблема, могу подготовить свежий диагноз — просто расскажи симптомы или пришли фото."
        )
        followups = [
            "Хочешь обновить план или добавить новый?",
            "Нужно подобрать время или препарат?",
        ]
        return answer, followups

    if intent == "confirm":
        answer = (
            "Хорошо, зафиксирую, как только скажешь, что именно поменять или подтвердить. "
            "Например, «перенеси на завтра утром» или «замени препарат на более мягкий»."
        )
        return answer, default_followups

    if intent == "reschedule":
        if upcoming:
            due_text = _format_due_datetime(upcoming.get("due_at"))
            stage_title = upcoming.get("stage_title") or "обработка"
            answer = (
                f"Ближайшая обработка «{stage_title}» стоит на {due_text}. "
                "Могу подобрать другое окно автоматически или открыть ручной выбор времени. "
                "Напиши, когда удобно, или нажми «🔁 Перенести» / «Подобрать время вручную» под карточкой."
            )
        else:
            answer = (
                "Сейчас нет назначенных обработок в календаре. "
                "Могу найти новое окно и предложить слоты или настроить напоминание на конкретное время."
            )
        followups = [
            "Подобрать новое время автоматически?",
            "Выбрать время вручную прямо в чате?",
        ]
        return answer, followups

    if intent == "cancel":
        if upcoming:
            due_text = _format_due_datetime(upcoming.get("due_at"))
            stage_title = upcoming.get("stage_title") or "обработка"
            answer = (
                f"Окей, можем отменить слот «{stage_title}» на {due_text}. "
                "Скажи, нужно ли запланировать новую дату позже или просто убрать напоминание."
            )
        else:
            answer = "Пока нет активных обработок. Могу очистить план целиком или создать новое напоминание, если понадобится."
        followups = [
            "Отменяем только ближайшую обработку или весь план?",
            "Нужно оставить заметку, чтобы вернуться позже?",
        ]
        return answer, followups

    if intent == "reminder":
        if upcoming:
            due_text = _format_due_datetime(upcoming.get("due_at"))
            answer = (
                f"Напоминание уже стоит на {due_text}. "
                "Хочешь продублировать его, получить SMS в Telegram или перенести на другое время?"
            )
        else:
            answer = (
                "Для этого плана напоминаний пока нет. "
                "Могу поставить уведомление за нужное количество часов или подобрать окно и напомнить за 30 минут до обработки."
            )
        followups = [
            "Создать напоминание на конкретный день?",
            "Подобрать окно и прислать уведомление перед обработкой?",
        ]
        return answer, followups

    if intent == "change_product":
        option = None
        if stages:
            options = stages[0].get("options") or []
            option = options[0] if options else None
        current_product = option.get("product_name") if option else None
        answer = (
            f"В плане для {object_label} сейчас используется {current_product or 'выбранный препарат из диагноза'}. "
            "Могу предложить альтернативы из справочника: скажи, какие ограничения или предпочтения важны (например, мягче, без меди, разрешён в теплице)."
        )
        followups = [
            "Нужен органический вариант?",
            "Сменить препарат или метод обработки?",
        ]
        return answer, followups

    return None


def _quote_user_message(message: str) -> str:
    if not message:
        return ""
    text = message.strip()
    if len(text) > 80:
        return text[:77] + "…"
    return text


def _detect_intent(message: str | None) -> str | None:
    if not message:
        return None
    text = message.strip().lower()
    if not text:
        return None

    def has_any(keywords: list[str]) -> bool:
        return any(keyword in text for keyword in keywords)

    if has_any(["перенес", "перенос", "другое время", "отлож", "переставь", "перенести"]):
        return "reschedule"
    if has_any(["отмен", "не надо", "убери", "откаж", "отключи"]):
        return "cancel"
    if has_any(["напомин", "напомни", "уведом"]):
        return "reminder"
    if has_any(["препарат", "средств", "замени", "другой препарат", "заменить"]):
        return "change_product"
    greetings = {"привет", "здравствуй", "добрый день", "доброе утро", "добрый вечер", "хай", "hello", "hi"}
    if text in greetings:
        return "greeting"
    confirmations = {"да", "ок", "хорошо", "ага", "угу", "ладно"}
    if text in confirmations:
        return "confirm"
    question_starts = ("как", "что", "когда", "почему", "зачем", "куда")
    references_plan = "план" in text
    if not references_plan and ("?" in text or text.startswith(question_starts)):
        return "question"
    return None


def _pick_upcoming_event(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc)
    candidates = []
    for event in events:
        due_at = event.get("due_at")
        if not due_at:
            continue
        try:
            dt = _parse_iso_dt(due_at)
            if dt is None:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if dt >= now:
            candidates.append((dt, event))
    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0])
    dt, event = candidates[0]
    event["due_at"] = dt.isoformat()
    return event


def _format_due_datetime(due_at: str | None) -> str:
    if not due_at:
        return "без времени"
    try:
        dt = _parse_iso_dt(due_at)
        if dt is None:
            return "в ближайшее время"
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local_dt = dt.astimezone()
        return local_dt.strftime("%d.%m %H:%M")
    except Exception:
        return "в ближайшее время"


def _parse_iso_dt(value: str) -> datetime | None:
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(cleaned)
    except Exception:
        return None


def _extract_diagnosis_record(record: dict[str, Any] | None, object_id: int | None) -> dict[str, Any] | None:
    if not record:
        return None
    if object_id and record.get("object_id") not in (None, object_id):
        return None
    return record


def _plan_payload_from_diagnosis(diag_record: dict[str, Any]) -> dict[str, Any] | None:
    payload = _coerce_diagnosis_payload(diag_record)
    if not payload:
        return None
    treatment = payload.get("treatment_plan") or {}
    product = (
        treatment.get("product")
        or treatment.get("substance")
        or payload.get("disease_name_ru")
        or "Рекомендованная обработка"
    )
    option = {
        "product_name": product,
        "ai": treatment.get("substance"),
        "dose_value": treatment.get("dosage_value"),
        "dose_unit": treatment.get("dosage_unit"),
        "method": treatment.get("method"),
        "notes": treatment.get("safety") or treatment.get("safety_note"),
        "phi_days": treatment.get("phi_days"),
    }
    stage = {
        "name": payload.get("disease_name_ru") or "Обработка",
        "trigger": "по согласованию",
        "notes": (payload.get("reasoning") or [None])[0],
        "options": [option],
    }
    return {
        "kind": "PLAN_NEW",
        "object_hint": payload.get("crop_ru") or payload.get("crop"),
        "diagnosis": {
            "crop": payload.get("crop"),
            "disease": payload.get("disease"),
            "confidence": payload.get("confidence"),
        },
        "stages": [stage],
    }


def _build_plan_proposal(plan_payload: dict[str, Any], object_id: int | None) -> dict[str, Any]:
    return {
        "proposal_id": None,
        "kind": "plan",
        "plan_payload": plan_payload,
        "suggested_actions": ["pin", "show_plans"],
        "object_id": object_id,
    }


def _coerce_diagnosis_payload(record: dict[str, Any] | None) -> dict[str, Any]:
    if not record:
        return {}
    raw = record.get("diagnosis_payload") or record.get("payload")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}
