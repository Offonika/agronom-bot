# Codegen Prompt for Cursor

Ты пишешь код строго по OpenAPI v1.4.0 (см. `openapi/openapi.yaml`).
Не выдумывай схем и эндпоинтов — используй только те, что описаны.

Каждый эндпоинт должен:
- требовать заголовки `X-API-Key`, `X-User-ID` и `X-API-Ver: v1`
- возвращать `ErrorResponse` с `.code` из enum: `LIMIT_EXCEEDED`, `BAD_REQUEST`, `GPT_TIMEOUT`, `UNAUTHORIZED`

Если используется HMAC-подпись:
- проверяй `X-Sign` и `signature` в теле через HMAC‑SHA256

Используй Pydantic для схем. Названия классов такие же, как в OpenAPI.

