"""GPT-Vision integration using the OpenAI client."""

from __future__ import annotations

import atexit
import base64
import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx
from openai import APITimeoutError, OpenAI, OpenAIError

from .storage import detect_image_type, get_public_url

logger = logging.getLogger("gpt")


_client: OpenAI | None = None
_http_client: httpx.Client | None = None
_TEMPERATURE_DISABLED = False
_TEMPERATURE_WARNING_EMITTED = False
_MODEL = (os.environ.get("OPENAI_VISION_MODEL") or "gpt-5").strip() or "gpt-5"
_ASSISTANT_MODEL = (os.environ.get("OPENAI_ASSISTANT_MODEL") or _MODEL).strip() or _MODEL
_MODEL_FALLBACK_RAW = os.environ.get("OPENAI_VISION_MODEL_FALLBACK", "").strip()
_MODEL_FALLBACK = _MODEL_FALLBACK_RAW or None
_OPENAI_HOST = "api.openai.com"


def _should_bypass_proxy(host: str) -> bool:
    raw = os.environ.get("NO_PROXY") or os.environ.get("no_proxy")
    if not raw:
        return False
    host = host.lower().strip().lstrip(".")
    if not host:
        return False
    for entry in raw.split(","):
        token = entry.strip().lower()
        if not token:
            continue
        if token == "*":
            return True
        token = token.lstrip(".")
        if host == token or host.endswith("." + token):
            return True
    return False


def _get_client() -> OpenAI:
    """Lazily build and cache the OpenAI client."""

    global _client, _http_client
    if _client is None:
        mounts: dict[str, httpx.HTTPTransport] = {}
        http_proxy = os.environ.get("HTTP_PROXY")
        https_proxy = os.environ.get("HTTPS_PROXY")
        bypass_proxy = _should_bypass_proxy(_OPENAI_HOST)
        if not bypass_proxy:
            if http_proxy:
                mounts["http://"] = httpx.HTTPTransport(proxy=http_proxy)
            if https_proxy:
                mounts["https://"] = httpx.HTTPTransport(proxy=https_proxy)

        _http_client = httpx.Client(mounts=mounts) if mounts else None
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY environment variable is not set")
        _client = OpenAI(api_key=api_key, http_client=_http_client)
    return _client


def _close_client() -> None:
    global _client, _http_client
    if _http_client is not None:
        _http_client.close()
    _http_client = None
    _client = None


atexit.register(_close_client)

_PROMPT_FALLBACK = """
Ты — ассистент «Карманный агроном». Получаешь фото растения и подсказку пользователя и возвращаешь **чистый JSON**:
{
  "crop": "англ./лат. культура",
  "crop_ru": "название по-русски",
  "disease": "латинское или англ. название болезни",
  "disease_name_ru": "болезнь по-русски",
  "confidence": 0.0-1.0,
  "reasoning": ["краткие признаки"],
  "treatment_plan": {
    "product": "может быть пусто",
    "substance": "обязательно действующее вещество/группа",
    "dosage_value": 2.5,
    "dosage_unit": "мл/10л",
    "method": "способ применения",
    "phi_days": 7,
    "phi": "строка со сроком ожидания",
    "safety_note": "меры защиты",
    "safety": "доп. заметка"
  },
  "next_steps": {"reminder":"…","green_window":"…","cta":"…"},
  "need_reshoot": false,
  "reshoot_tips": ["если уверенность < 0.6 — 2-3 совета"],
  "need_clarify_crop": false,
  "clarify_crop_variants": ["до 3 культур"],
  "assistant_ru": "подробный ответ в свободной форме",
  "assistant_followups_ru": ["до 3 вопросов"]
}

Правила:
1. Только чистый JSON, без Markdown и backtick.
2. Если уверенность < 0.6 или фото плохое — ставь need_reshoot=true, давай советы и честно предупреждай.
3. Даже при низкой уверенности возвращай безопасный план (минимум substance + method + phi_days).
4. Учитывай crop_hint, но проверяй по фото.
5. Не придумывай названия препаратов — product можно оставить пустым.

Требования к `assistant_ru`:
- Пиши дружелюбно и подробно, как в примере:
  ```
  Это растение — аглаонема (Aglaonema), называют «китайским вечнозелёным».

  🔍 Что видно на фото:
  - …
  - …

  ⚙️ Возможные причины:
  - сухой воздух — …
  - жёсткая вода — …

  🛠️ Что делать:
  - обработай инсектицидом…
  - следи за влажностью…

  🪴 Уход дальше:
  - полив 1–2 раза в неделю…
  - протирай листья…
  ```
- Обязательно упоминание культуры, наблюдения, причин и конкретных шагов. Используй эмодзи в заголовках блоков, добавляй ободряющее завершение.

`assistant_followups_ru` — 2–3 возможных вопроса пользователя. Если вредителей нет, честно напиши и сосредоточься на уходе. Никакого текста вне JSON.
""".strip()


def _load_system_prompt() -> str:
    root = Path(__file__).resolve().parents[2]
    path = root / "prompts" / "diagnosis_system.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        logger.warning("Failed to read diagnosis_system.md, using fallback prompt")
        return _PROMPT_FALLBACK


_PROMPT = _load_system_prompt()


def _load_timeout() -> int:
    raw = os.environ.get("OPENAI_TIMEOUT_SECONDS")
    if not raw:
        return 60
    raw = raw.strip()
    if not raw:
        return 60
    try:
        value = int(float(raw))
    except ValueError:
        logger.warning("Invalid OPENAI_TIMEOUT_SECONDS '%s'; using default 60", raw)
        return 60
    if value <= 0:
        logger.warning("OPENAI_TIMEOUT_SECONDS must be positive, got %s; using default 60", raw)
        return 60
    return value


_TIMEOUT_SECONDS = _load_timeout()


def _get_temperature_setting() -> float | None:
    """Return configured temperature unless disabled or invalid."""

    global _TEMPERATURE_WARNING_EMITTED
    if _TEMPERATURE_DISABLED:
        return None

    raw = os.environ.get("OPENAI_TEMPERATURE")
    if raw is None:
        return None

    raw = raw.strip()
    if not raw:
        return None

    try:
        return float(raw)
    except ValueError:
        if not _TEMPERATURE_WARNING_EMITTED:
            logger.warning("Invalid OPENAI_TEMPERATURE '%s'; ignoring", raw)
            _TEMPERATURE_WARNING_EMITTED = True
        return None


def _is_temperature_rejection(exc: OpenAIError) -> bool:
    """Detect API errors that indicate temperature is unsupported."""

    error_body = getattr(exc, "body", None)
    if isinstance(error_body, dict):
        details = error_body.get("error")
        if isinstance(details, dict):
            param = str(details.get("param") or "").lower()
            if param == "temperature":
                return True
            message = str(details.get("message") or "").lower()
            if "temperature" in message:
                return True
            code = str(details.get("code") or "").lower()
            if "temperature" in code:
                return True

    message_attr = getattr(exc, "message", "") or ""
    message = str(message_attr or exc).lower()
    return "temperature" in message and (
        "default" in message or "supported" in message or "unsupported" in message
    )


def _execute_completion(client: OpenAI, kwargs: dict[str, Any]) -> Any:
    """Send request to OpenAI and normalize timeout errors."""

    try:
        return client.chat.completions.create(**kwargs)
    except APITimeoutError as exc:
        raise TimeoutError("OpenAI request timed out") from exc


def _build_image_source(key: str, image_bytes: bytes | None) -> str:
    if image_bytes:
        img_type = detect_image_type(image_bytes) or "jpeg"
        data = base64.b64encode(image_bytes).decode("ascii")
        return f"data:image/{img_type};base64,{data}"
    return get_public_url(key)


def _request_completion(client: OpenAI, model: str, base_payload: dict[str, Any]):
    request_kwargs = dict(base_payload)
    request_kwargs["model"] = model

    temperature = _get_temperature_setting()
    include_temperature = temperature is not None
    if include_temperature:
        request_kwargs["temperature"] = temperature

    try:
        return _execute_completion(client, request_kwargs)
    except OpenAIError as exc:  # pragma: no cover - network/SDK errors
        if include_temperature and _is_temperature_rejection(exc):
            global _TEMPERATURE_DISABLED
            _TEMPERATURE_DISABLED = True
            logger.warning(
                "OpenAI model %s rejected custom temperature; retrying with default.",
                model,
                exc_info=True,
            )
            retry_kwargs = {k: v for k, v in request_kwargs.items() if k != "temperature"}
            try:
                return _execute_completion(client, retry_kwargs)
            except OpenAIError as retry_exc:  # pragma: no cover
                logger.exception("GPT request failed: %s", retry_exc)
                raise RuntimeError("OpenAI request failed") from retry_exc
        logger.exception("GPT request failed: %s", exc)
        raise RuntimeError("OpenAI request failed") from exc


def call_gpt_vision(
    key: str, image_bytes: bytes | None = None, *, crop_hint: str | None = None
) -> dict:
    """Send photo to GPT‑Vision and parse the diagnosis.

    Parameters
    ----------
    key: str
        S3 object key returned by :func:`app.services.storage.upload_photo`.
    image_bytes: Optional bytes to inline as data URI.
    """

    image_url = _build_image_source(key, image_bytes)

    client = _get_client()
    hint = (crop_hint or "").strip()
    hint_suffix = ""
    if hint:
        hint_clean = hint[:64]
        hint_suffix = (
            " Пользователь предполагает культуру: "
            f"{hint_clean}. Учитывай подсказку, если она согласуется с фото."
        )
    base_payload: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": _PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Определи культуру, проблему и подготовь JSON по схеме выше. "
                            "Ответь дружелюбно, но оставь только JSON."
                            + hint_suffix
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        "timeout": _TIMEOUT_SECONDS,
        "response_format": {"type": "json_object"},
    }

    try:
        response = _request_completion(client, _MODEL, base_payload)
    except TimeoutError as primary_timeout:
        fallback = _MODEL_FALLBACK if _MODEL_FALLBACK and _MODEL_FALLBACK != _MODEL else None
        if fallback:
            logger.warning(
                "Primary model %s timed out; falling back to %s.",
                _MODEL,
                fallback,
            )
            response = _request_completion(client, fallback, base_payload)
        else:
            raise primary_timeout

    try:
        payload = response.choices[0].message.content
        if isinstance(payload, list):
            fragments: list[str] = []
            for part in payload:
                text = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
                if text is None and hasattr(part, "content"):
                    text = getattr(part, "content")
                fragments.append(str(text or ""))
            payload_str = "".join(fragments)
        else:
            payload_str = str(payload or "")
        cleaned = payload_str.strip()
        logger.info("GPT JSON payload: %s", cleaned)
        data = json.loads(cleaned or "{}")
        crop = str(data["crop"]).strip()
        disease = str(data["disease"]).strip()
        crop_ru = _clean(data.get("crop_ru"))
        disease_name_ru = _clean(data.get("disease_name_ru"))
        confidence = float(data["confidence"])
        reasoning = _as_list(data.get("reasoning"))

        plan = _sanitize_plan(data.get("treatment_plan"))

        next_raw: Any = data.get("next_steps") or {}
        next_steps: dict[str, str] | None = None
        if isinstance(next_raw, dict):
            next_candidate = {
                "reminder": _clean(next_raw.get("reminder")),
                "green_window": _clean(next_raw.get("green_window")),
                "cta": _clean(next_raw.get("cta")),
            }
            if any(next_candidate.values()):
                next_steps = next_candidate

        need_reshoot = bool(data.get("need_reshoot"))
        reshoot_tips = _as_list(data.get("reshoot_tips"))
        need_clarify_crop = bool(data.get("need_clarify_crop"))
        clarify_crop_variants = _as_list(data.get("clarify_crop_variants"))
        assistant_ru = _clean(data.get("assistant_ru"))
        assistant_followups = _as_list(data.get("assistant_followups_ru"))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, IndexError) as exc:
        raise ValueError("Malformed GPT response") from exc

    return {
        "crop": crop,
        "disease": disease,
        "crop_ru": crop_ru or None,
        "disease_name_ru": disease_name_ru or None,
        "confidence": confidence,
        "reasoning": reasoning or None,
        "treatment_plan": plan,
        "next_steps": next_steps,
        "need_reshoot": need_reshoot,
        "reshoot_tips": reshoot_tips or None,
        "need_clarify_crop": need_clarify_crop,
        "clarify_crop_variants": clarify_crop_variants or None,
        "assistant_ru": assistant_ru or None,
        "assistant_followups_ru": assistant_followups or None,
    }


def call_gpt_chat(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    response_format: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> str:
    """Send a text-only chat completion and return the raw content string."""

    client = _get_client()
    base_payload: dict[str, Any] = {
        "messages": messages,
        "timeout": timeout or _TIMEOUT_SECONDS,
    }
    if response_format is not None:
        base_payload["response_format"] = response_format
    response = _request_completion(client, model or _ASSISTANT_MODEL, base_payload)
    payload = response.choices[0].message.content
    if isinstance(payload, list):
        fragments: list[str] = []
        for part in payload:
            text = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
            if text is None and hasattr(part, "content"):
                text = getattr(part, "content")
            fragments.append(str(text or ""))
        return "".join(fragments)
    return str(payload or "")


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        result = []
        for item in value:
            text = _clean(item)
            if text:
                result.append(text)
        return result
    text = _clean(value)
    return [text] if text else []


def _to_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _sanitize_plan(plan_raw: Any) -> dict[str, Any] | None:
    if not isinstance(plan_raw, dict):
        return None
    candidate: dict[str, Any] = {
        "product": _clean(plan_raw.get("product")),
        "substance": _clean(plan_raw.get("substance")),
        "dosage": _clean(plan_raw.get("dosage")),
        "dosage_value": _to_float(plan_raw.get("dosage_value")),
        "dosage_unit": _clean(plan_raw.get("dosage_unit")),
        "method": _clean(plan_raw.get("method")),
        "phi": _clean(plan_raw.get("phi")),
        "phi_days": _to_int(plan_raw.get("phi_days")),
        "safety_note": _clean(plan_raw.get("safety_note") or plan_raw.get("safety")),
        "safety": _clean(plan_raw.get("safety")),
    }
    core_ok = bool(
        candidate["substance"] or candidate["method"] or candidate["phi_days"] is not None
    )
    return candidate if core_ok else None


__all__ = ["call_gpt_vision", "call_gpt_chat"]
