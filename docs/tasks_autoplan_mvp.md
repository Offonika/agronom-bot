# План задач — Память плана и автоплан (MVP)

Версия: 13.11.2025

## 0. Общее
- Репозиторий: agronom-bot.
- Цель: реализовать память планов + автопланирование «зелёных окон» в соответствии с документами `docs/prd.md`, `docs/srs.md`, `docs/DB_SCHEMA.md`, `docs/API.md`, `docs/ALGORITHMS/auto_planner.md`.
- Все PR → develop, DoD из PRD/SRS обязательны. После каждого шага обновлять документацию, если меняется поведение.
- Отмечать выполнение задач (чекбокс/✅ + дата и пройденные тесты/линты) прямо в этом плане или связанном тикете; при блокировке добавлять `⚠ blocked: причина, дата`.

## 1. DB & миграции
- **Описание:** добавить таблицы `objects`, `cases`, `plans`, `plan_stages`, `stage_options`, `events`, `reminders`, `autoplan_runs`, `treatment_slots`, расширить `products`/`product_rules`.
- **Детали:** следовать `docs/DB_SCHEMA.md`; не забыть уникальные ключи, индексы `events_user_due_idx`, `reminders_pending_idx`.
- **DoD:** миграции проходят через стандартный механизм проекта (Alembic или существующие скрипты); `pytest` использует новые модели; ER-диаграмма в документации обновлена (если изменилась); уникальные ограничения для автоплан-слотов (`stage_option_id + slot_start`) проверены тестами.
- **Зависимости:** нет (базовый слой).

## 2. Catalog Importer & сидер
- **Описание:** реализовать импорт `data/product_rules.csv` в `products` и `product_rules`.
- **Детали:** идемпотентный скрипт `scripts/import_catalog.py`, конфиг `CATALOG_IMPORT_PATH`.
- **DoD:** локальный запуск создаёт 20+ записей; unit-тесты покрывают маппинг и режим needs_review.
- **Зависимости:** таблицы из задачи 1.

## 3. Domain layer (services)
- **Описание:** сервис нормализации `plan_payload`, преобразование в entities, определение `kind`, валидация доз/PHI/product_rules, расчёт hash и статусов (draft/proposed/accepted/...).
- **Детали:** функции `normalize_plan(payload)`, `compare_plan(new, current)`, `plan_service.create_draft`, механика `needs_review`.
- **DoD:** модульные тесты на PLAN_NEW/PLAN_UPDATE/QNA, дубликаты (одинаковый hash → без нового draft), обнаружение needs_review, детерминированный hash.
- **Зависимости:** готовая БД и каталог.

## 4. API (FastAPI)
- **Описание:** реализовать первоочередные эндпоинты из `docs/API.md` (`/plans/{id}`, `/plans/{id}/accept`, `/plans/{id}/select-option`, `/treatments/{id}/autoplan`, `/reminders/due`, `/reminders/{id}/status`). Остальные вынести в backlog при необходимости.
- **Детали:** использовать существующую схему авторизации (API-ключ или иная); поддержать фильтрацию по user/object и режим diff для `/plans/{id}`.
- **DoD:** OpenAPI обновлён; Spectral + openapi-diff проходят; интеграционные тесты с тестовой БД.
- **Зависимости:** задачи 1–3.

## 5. Autoplan worker
- **Описание:** создать воркер (Python или Node) по алгоритму `docs/ALGORITHMS/auto_planner.md`.
- **Детали:** инпут — запись в `autoplan_runs`; output — запись слота и события/напоминания; поддержать состояния `pending/window_found/awaiting_window/failed`; в рамках задачи реализовать `weather_service` по описанному контракту.
- **DoD:** unit-тесты на подбор слота и сценарий «окон нет»; reason формируется как список сработавших правил (человеко-читаемая строка); воркер переиспользует `AUTOPLAN_MIN_HOURS_AHEAD`.
- **Зависимости:** API (задача 4) для запуска через HTTP/queue.

## 6. Reminders & bot notifications
- **Описание:** реализовать воркер выборки `/reminders/due`, отправку через Telegram, обновление статусов, команды `/done`, `/skip`.
- **Детали:** учесть `REMINDER_TICK_MS`, `REMINDER_DEFAULT_DELAY_H`; интеграция с существующим ботом (модули `bot/reminders.js`, `bot/callbacks`).
- **DoD:** e2e-тест с локальной БД и Telegram sandbox; проверено, что рестарт не приводит к повторной отправке уже `sent` напоминаний; идемпотентность статусов.
- **Зависимости:** задачи 1–5.

- **Описание:** доработать модули бота (`bot/diagnosis.js`, `bot/planCommands.js`, `bot/objectChips.js`) для:
  - выбора объекта (чипы),
  - интеграции normalize_plan/plan_service в flow диагноза (parsing plan_payload и сохранение draft),
  - отображения таблицы этапов,
  - приёма PLAN_NEW/PLAN_UPDATE и диффа,
  - карточки автоплана («Принять/Изменить/Сделать вручную»),
  - выбора варианта одной кнопкой (`/plans/{id}/select-option` + создание событий/напоминаний),
  - обработки PLAN_UPDATE с кнопками «Принять/Отклонить/Частично»,
  - дефолтных фоллоу-апов.
- **DoD:** jest-тесты обновлены; UX соответствует `docs/UX/flows.md`; ручная проверка happy-path U1/U2/U3.
- **Зависимости:** сервисы/ API готовы.

## 8. Logging & monitoring
- **Описание:** внедрить формат из `docs/LOGGING.md`, события plan/autoplan/reminders, метрики Prometheus и интеграцию с существующим `app/logger`.
- **DoD:** логи присутствуют в ключевых точках, алерты настроены (или добавлены задачи в backlog), retry-логика учитывает новые события.
- **Зависимости:** после реализации функционала.

## 9. QA & Docs
- **Описание:** финальные проверки, обновление `CHANGELOG.md`, дополнение `docs/index.md` ссылками на новые документы, инструкции в README.
- **DoD:** ruff/pytest/npm test проходят; docs отражают итоговую реализацию; PR содержит ссылки на тикеты и тест-план.

## 10. Backlog/следующие итерации
- ML-ранжирование окон (vNext).
- Интеграция с внешними погодными API (fallback).
- UI для частичного принятия с drag&drop.

> Совет: завести отдельный Epic «Plan Memory & Auto-Planning» и добавить выше перечисленные задачи как issue, чтобы удобно трекать прогресс.
