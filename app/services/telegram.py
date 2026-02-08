from __future__ import annotations

from datetime import datetime, timezone
import logging
import os

import httpx

logger = logging.getLogger(__name__)


def _bot_token() -> str | None:
    token = os.getenv("BOT_TOKEN_PROD") or os.getenv("BOT_TOKEN_DEV")
    if not token:
        return None
    return token.strip()


async def send_bot_message(chat_id: int, text: str) -> bool:
    token = _bot_token()
    if not token:
        logger.warning("Telegram token missing, skip notification")
        return False
    api_base = os.getenv("TELEGRAM_API_BASE", "https://api.telegram.org")
    url = f"{api_base.rstrip('/')}/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10)
        if resp.status_code >= 400:
            logger.warning("Telegram send failed: %s", resp.text)
            return False
        data = resp.json()
        return bool(data.get("ok", True))
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Telegram send failed: %s", exc)
        return False


async def notify_autopay_failure(chat_id: int, status: str | None = None) -> bool:
    text = os.getenv(
        "AUTOPAY_FAIL_TEXT",
        "Не удалось списать оплату за PRO. Оплатите вручную в /subscribe.",
    )
    if status:
        text = f"{text}\nСтатус: {status}"
    return await send_bot_message(chat_id, text)


def _format_expiry(expires_at: datetime | None) -> str | None:
    if not expires_at:
        return None
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at.strftime("%Y-%m-%d")


async def notify_autopay_success(
    chat_id: int, expires_at: datetime | None = None
) -> bool:
    text = os.getenv(
        "AUTOPAY_SUCCESS_TEXT",
        "Автоплатёж прошёл успешно. PRO продлён.",
    )
    date = _format_expiry(expires_at)
    if date:
        text = f"{text}\nДействует до: {date}"
    return await send_bot_message(chat_id, text)


async def notify_autopay_disabled(
    chat_id: int, reason: str | None = None
) -> bool:
    text = os.getenv(
        "AUTOPAY_DISABLED_TEXT",
        "Автопродление отключено после неудачных попыток оплаты. "
        "Оплатите вручную в /subscribe и включите автопродление снова.",
    )
    if reason:
        text = f"{text}\nПричина: {reason}"
    return await send_bot_message(chat_id, text)
