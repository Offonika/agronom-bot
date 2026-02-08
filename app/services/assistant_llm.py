"""LLM-backed response builder for assistant chat."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from app.services.gpt import call_gpt_chat

logger = logging.getLogger(__name__)


def llm_enabled() -> bool:
    raw = os.environ.get("ASSISTANT_LLM_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def build_llm_response(
    message: str,
    context: dict[str, Any],
) -> tuple[str | None, list[str] | None]:
    if not message:
        return None, None
    prompt = _build_prompt()
    payload = json.dumps(
        {
            "message": message,
            "context": context,
        },
        ensure_ascii=False,
    )
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": payload},
    ]
    raw = call_gpt_chat(messages, response_format={"type": "json_object"})
    try:
        data = json.loads(raw.strip() or "{}")
    except json.JSONDecodeError as exc:
        logger.warning("assistant_llm.invalid_json: %s", exc)
        return None, None
    assistant_message = _clean_text(data.get("assistant_message"))
    followups = _clean_followups(data.get("followups"))
    return assistant_message, followups


def _build_prompt() -> str:
    return (
        "Ты — живой ассистент «Карманный агроном» в Telegram. "
        "Отвечай по-русски, кратко и по делу. Используй контекст пользователя (планы, этапы, события) "
        "и объясняй, что делать дальше. "
        "Если в доступных действиях есть кнопки, упоминай только их и не выдумывай новые команды. "
        "Не говори, что ты ИИ.\n\n"
        "Верни ТОЛЬКО JSON:\n"
        "{\n"
        '  "assistant_message": "основной ответ",\n'
        '  "followups": ["до 3 уточняющих вопросов"]\n'
        "}\n"
        "Если уточняющие вопросы не нужны — верни пустой массив followups."
    )


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _clean_followups(value: Any) -> list[str] | None:
    if not value:
        return None
    if isinstance(value, str):
        return [value.strip()] if value.strip() else None
    if isinstance(value, list):
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        return cleaned[:3] if cleaned else None
    return None
