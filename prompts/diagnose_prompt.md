# Diagnose Prompt for GPT-Vision

GPT‑Vision принимает фото и возвращает диагноз в виде JSON:
```json
{ "crop": "apple", "disease": "powdery_mildew", "confidence": 0.91 }
```
Если confidence < 0.2 → ошибка NO_LEAF
Если LLM не отвечает > 10 секунд → ошибка GPT_TIMEOUT, статус pending.

Ответ всегда проверяется: .crop, .disease, .confidence ∈ [0..1].
