# DB Schema — Plan Memory & Auto-Planning

Версия: 0.1 (13.11.2025)

Документ описывает минимальную ER-схему для поддержки памяти планов, мульти-объектов и автопланирования. Хранилище — PostgreSQL 14+.

## 1. Сущности

### users
- `id` (PK), `tg_id` (UNIQUE), `name`, `pro_expires_at`, `locale`, `timezone`, `created_at`, `updated_at`.
- Индекс: `users_tg_id_idx` (уникальный).

### objects
- Привязка пользователя к грядкам/растениям.
- Поля: `id`, `user_id` (FK users), `title`, `crop`, `photo_url`, `is_default`, `created_at`, `archived_at`.
- Индекс: `objects_user_active_idx (user_id, archived_at NULLS FIRST)`.

### cases
- Диагноз по объекту.
- `id`, `object_id` (FK objects), `diagnosis_code`, `diagnosis_name`, `confidence`, `status` (active/closed), `created_at`.
- Индекс: `cases_object_active_idx (object_id, status)`.

### plans
- Версионируемые планы.
- Поля: `id`, `case_id` (FK cases), `object_id`, `version`, `status` (draft/proposed/accepted/scheduled/superseded/rejected), `source` (PLAN_NEW | PLAN_UPDATE), `hash` (SHA-1 канонического JSON), `payload` (JSONB оригинального пакета), `created_at`, `accepted_at`, `scheduled_at`, `superseded_by`.
- Уникальный ключ: `(case_id, version)`.
- Индекс: `plans_object_case_idx (object_id, case_id, status)`.

### plan_stages
- Дочерние записи плана.
- Поля: `id`, `plan_id`, `stage_order`, `name`, `trigger`, `notes`.
- Индекс: `plan_stages_plan_idx (plan_id, stage_order)`.

### stage_options
- До трёх вариантов на этап.
- Поля: `id`, `plan_stage_id`, `product_id` (nullable), `product_name`, `ai`, `dose_value`, `dose_unit`, `method`, `phi_days`, `notes`, `needs_review`, `is_selected`.
- Индекс: `stage_options_stage_idx (plan_stage_id, is_selected)` для быстрых выборок UI.

### events
- Конкретные действия (обработка, контроль дождя, PHI).
- Поля: `id`, `plan_id`, `plan_stage_id`, `stage_option_id`, `user_id`, `object_id`, `type` (treatment|rain_check|phi|custom), `status` (scheduled|done|skipped|expired), `slot_start`, `slot_end`, `reason`, `created_at`, `updated_at`.
- Индекс: `events_user_due_idx (user_id, slot_start) WHERE status='scheduled'`.
- Уникальность автоплана: `(stage_option_id, slot_start)` — не допускает дубликат слотов.

### reminders
- Push/бот-уведомления.
- Поля: `id`, `event_id` (FK events), `user_id`, `fire_at`, `sent_at`, `channel`, `payload` (JSONB), `status` (pending|sent|cancelled|failed).
- Индекс: `reminders_pending_idx (fire_at) WHERE sent_at IS NULL`.

### products
- Нормализованный справочник препаратов.
- Поля: `id`, `product_code`, `name`, `ai`, `form_factor`, `manufacturer`, `is_allowed`, `metadata` (JSONB).
- Индексы: `products_code_idx`, `products_ai_idx`.

### product_rules
- Ограничения по культурам/регионам.
- Поля: `id`, `product_id`, `crop`, `region`, `usage_class` (fungicide/insecticide...), `dose_min`, `dose_max`, `dose_unit`, `phi_days`, `safe_phase`, `priority`, `notes`.
- Индекс: `product_rules_crop_region_idx (crop, region)`.
- Поле `priority` используется для сортировки опций и фильтрации аналогов.

### autoplan_runs
- История запусков автопланировщика.
- `id`, `plan_id`, `stage_option_id`, `treatment_id`, `status` (pending|window_found|awaiting_window|failed), `reason`, `forecast_version`, `started_at`, `finished_at`.

### treatment_slots
- Результат автоплана.
- `id`, `plan_id`, `stage_option_id`, `slot_start`, `slot_end`, `reason`, `score`, `status` (proposed|accepted|rejected).
- Уникальный ключ: `(stage_option_id, slot_start)`.

## 2. Идемпотентность

- `plans.hash` используется, чтобы не создавать одинаковые черновики (анти-дребезг).
- `events` и `treatment_slots` используют композиционный ключ `(stage_option_id, slot_start)` — повторная запись с тем же окном не создаётся.
- `autoplan_runs` содержит `forecast_version`, что позволяет перезапускать задачу только при новом прогнозе.

## 3. JSONB-поля (канонизация)

- `plans.payload` хранит оригинальный пакет от ИИ (текст + машинный вид) для аудита.
- `reminders.payload` — канал-специфичные данные (текст, deeplink, CTA).
- `products.metadata` — дополнительные свойства (PHI ограничения, разрешённые аналоги, ссылки на инструкции).

## 4. Индексы и производительность

- `events_user_due_idx` обеспечивает выборку ближайших «зелёных окон»/напоминаний для пользователя.
- `reminders_pending_idx` используется воркером напоминаний (tick из ENV `REMINDER_TICK_MS`).
- Дополнительные индексы: `plans_status_idx (status, updated_at DESC)` для аналитики; `cases_status_idx` для выборки активных диагнозов.

## 5. Диаграмма (текстом)

```
users 1—∞ objects 1—∞ cases 1—∞ plans 1—∞ plan_stages 1—∞ stage_options
stage_options 1—∞ events 1—∞ reminders
products 1—∞ product_rules
stage_options — products (optional FK)
plans — treatment_slots (1—∞)
```

## 6. Хуки и каскады

- Удаление объекта архивирует связанные cases/plans/events (soft delete через `archived_at`/`status`).
- Смена выбранной опции на этапе апдейтит `stage_options.is_selected` и пересоздаёт события в транзакции.

Документ служит базой для Alembic-миграций и синхронизируется с `docs/API.md`.
