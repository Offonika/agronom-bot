prompts/diagnose_prompt.md
md

# Diagnose Prompt for GPT-Vision

GPT‑Vision принимает фото и возвращает диагноз в виде JSON:
```json
{ "crop": "apple", "disease": "powdery_mildew", "confidence": 0.91 }
Если confidence < 0.2 → ошибка NO_LEAF
Если LLM не отвечает > 10 секунд → ошибка GPT_TIMEOUT, статус pending.

Ответ всегда проверяется: .crop, .disease, .confidence ∈ [0..1].

yaml


---

### 📄 `prompts/security_prompt.md`

```md
# Security Prompt for Cursor

Все запросы должны требовать заголовки:
- `X-API-Key` — обязательный API ключ
- `X-API-Ver: v1` — версия API

Эндпоинты для партнёров (webhook) используют HMAC‑SHA256:
- в заголовке `X-Sign`
- в теле: поле `signature`
- вычисляется по сырому `body`, секрет хранится в Vault

Если сигнатура неверна → верни `401 UNAUTHORIZED`

Если пользователь превысил лимит 5 фото/мес → `429 LIMIT_EXCEEDED`
