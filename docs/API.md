# API Contracts — Plan Memory & Auto-Planning

Версия: 0.2 (21.11.2025) — добавлены эндпоинты ассистента (/assistant/chat, /assistant/confirm_plan)

## 1. Treatments & Plans
### POST /assistant/chat

- **Purpose:** живой ассистент отвечает на вопросы, оркестрируя запросы к diagnose/plan/logbook/weather без дублирования логики мастера.
- **Request body (кратко)** `{ "session_id": "uuid?", "object_id": "uuid?", "message": "string", "metadata": { "recent_diagnosis_id?": "uuid", "plan_session_id?": "uuid" } }`
- **Response** `{ "assistant_message": "text", "proposals": [{ "proposal_id": "uuid", "kind": "plan|event", "plan_payload": {...}, "suggested_actions": ["pin","ask_clarification","show_plans"] }] }`
- Ассистент добавляет CTA «📌 Зафиксировать» для предложений plan/event.

### POST /assistant/confirm_plan

- **Purpose:** превращает предложение ассистента в структурированные сущности.
- **Request body (кратко)** `{ "proposal_id": "uuid", "object_id": "uuid", "preferred_time?": "ISO8601", "plan_session_id?": "uuid" }`
- **Behavior:** вызывает те же сервисы, что мастер по фото (draft→proposed→accepted/scheduled, события/напоминания, автоплан или ручной слот).
- **Response** `{ "status": "accepted|scheduled", "plan_id": "uuid", "event_ids": ["uuid"], "reminder_ids": ["uuid"] }`

### POST /plans

- **Purpose:** создать план из `plan_payload` (assistant/master).
- **Request body** `{ "object_id": 1, "case_id?": 2, "plan_payload": { ... } }`
- **Response** `{ "plan_id": 10, "stages": [{ "stage_id": 11, "option_ids": [111, 112]}], "errors": [] }`

### POST /plans/{id}/events

- **Purpose:** создать событие/напоминание для этапа.
- **Request body** `{ "stage_id": 11, "stage_option_id?": 111, "due_at?": "ISO", "slot_end?": "ISO", "reason?": "string" }`
- **Response** `{ "event_ids": [201], "reminder_ids": [301] }`

### POST /plans/{id}/autoplan

- **Purpose:** поставить автоплан в очередь.
- **Request body** `{ "stage_id": 11, "stage_option_id": 111, "min_hours_ahead": 2, "horizon_hours": 72 }`
- **Response 202** `{ "autoplan_run_id": 401, "status": "pending" }`

### POST /treatments/{id}/autoplan

- **Purpose:** запускает подбор «зелёного окна» для опции, выбранной пользователем или рекомендованной ИИ.
- **Request body**
```json
{
  "stage_option_id": "uuid",
  "min_hours_ahead": 2,
  "max_horizon_hours": 72,
  "respect_existing_events": true
}
```
- **Response 202**
```json
{
  "autoplan_run_id": "uuid",
  "status": "pending"
}
```
- Идемпотентность: одинаковый `stage_option_id` + `slot_start` не создаёт дублирующих событий (см. DB_SCHEMA).

### GET /plans/{id}

Возвращает последнюю версию плана.

```json
{
  "plan_id": "uuid",
  "object_id": "uuid",
  "case_id": "uuid",
  "status": "proposed",
  "version": 3,
  "hash": "sha1",
  "stages": [
    {
      "stage_id": "uuid",
      "name": "До цветения",
      "trigger": "до распускания почек",
      "options": [
        {
          "option_id": "uuid",
          "product_code": "TILT-250",
          "product_name": "Тилт 250",
          "ai": "пропиконазол",
          "dose": { "value": 0.5, "unit": "л/га" },
          "method": "опрыскивание",
          "phi_days": 30,
          "notes": "не проводить при ветре >5 м/с",
          "needs_review": false,
          "is_selected": true
        }
      ]
    }
  ],
  "events": [
    {
      "event_id": "uuid",
      "type": "treatment",
      "status": "scheduled",
      "slot_start": "2025-04-12T17:00:00+03:00",
      "slot_end": "2025-04-12T19:00:00+03:00",
      "reason": "без дождя 12 ч, ветер 3 м/с, +12 °C"
    }
  ],
  "diff": null
}
```

Parameters:
- `?diff_against=accepted` — строит diff с последним accepted/scheduled планом.
- `?include_payload=true` — добавляет оригинальный JSON `plan_payload`.

### POST /plans/{id}/accept

```json
{
  "stage_option_ids": ["uuid"],
  "apply_to_existing_events": "none|future|all",
  "comment": "Применить только к будущим этапам"
}
```

Response 200:
```json
{
  "plan_id": "uuid",
  "status": "accepted",
  "scheduled_event_ids": ["uuid1","uuid2"]
}
```

### POST /plans/{id}/reject

- Помечает предложенный PLAN_UPDATE как `rejected`, копирует ссылку на предыдущий accepted план.

### POST /plans/{id}/select-option

- Позволяет мгновенно переключить вариант на этапе (кнопка в UI).
- Тело: `{ "stage_option_id": "uuid" }`.
- Возвращает обновлённый план (статус меняется на `accepted`/`scheduled`, если были события).

## 2. Reminders Worker

### GET /reminders/due?limit=100

Ответ:
```json
{
  "reminders": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "event_id": "uuid",
      "channel": "telegram",
      "fire_at": "2025-04-12T12:00:00+03:00",
      "payload": {
        "text": "Сегодня окно для обработки «Тилт» c 17:00 до 19:00",
        "buttons": [
          {"text": "Принять", "callback": "plan.accept:uuid"},
          {"text": "Изменить окно", "callback": "plan.slot:uuid"}
        ]
      }
    }
  ]
}
```

### POST /reminders/{id}/status

```json
{
  "status": "sent|failed|cancelled",
  "error": "optional string"
}
```

## 3. Machine Package from AI

Формат, который сохраняется в `plans.payload` и передаётся из контроллера диагноза:

```json
{
  "kind": "PLAN_NEW",
  "object_hint": "ежевика, грядка 3",
  "diagnosis": {
    "crop": "Rubus fruticosus",
    "disease": "Осеннее старение",
    "confidence": 0.82
  },
  "stages": [
    {
      "name": "После листопада",
      "trigger": "до устойчивых морозов",
      "options": [
        {
          "product_name": "Медный оксихлорид",
          "ai": "медь (II)",
          "dose": {"value": 30, "unit": "г/10 л"},
          "method": "опрыскивание по побегам",
          "phi_days": 0,
          "notes": "расход 10 л/сотка"
        }
      ]
    }
  ],
  "notes_for_user": "удалите поражённые побеги, мульчируйте 5–7 см",
  "next_steps": {
    "green_window_hint": "вечером (19:00–22:00), без осадков",
    "cta": ["Запланировать обработку", "Поставить напоминание PHI"]
  }
}
```

Правила:
- `kind` обязателен. Значения: PLAN_NEW, PLAN_UPDATE, QNA, FAQ.
- `stages` не пустой массив для PLAN_*.
- Опциональные поля (`object_hint`, `notes_for_user`) используются UI, но не обязательны для ядра.

## 4. Error Codes (добавление к 4.4 SRS)

- `409 PLAN_CONFLICT` — попытка принять план, когда есть более свежий accepted/scheduled.
- `422 PLAN_VALIDATION_FAILED` — проблема на этапе нормализации (например, неизвестная единица дозировки).
- `425 WINDOW_NOT_READY` — автоплан ещё ищет слот (статус `awaiting_window`).

## 5. Internal Events

- `plan.updated` — публикуется при переходе draft → proposed/accepted.
- `plan.autoplan.window-found` — содержит `plan_id`, `stage_option_id`, `slot_start`, `reason`.
- `reminder.sent` / `reminder.failed` — для аналитики и ретраев.
