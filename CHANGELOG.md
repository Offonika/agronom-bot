# Changelog

## [Unreleased] — 2025-11-13

### Added
- feat: план памяти (draft → proposed → accepted → scheduled) и автопланирование «зелёных окон» (MVP).
- feat: карточка автоплана с кнопками «Принять/Выбрать другое время/Отменить», обновлённый воркер и интерактивная обработка слотов.
- feat: быстрый ручной выбор времени (сегодня вечером/завтра утром/выбрать дату) с напоминаниями, если автоплан недоступен.
- feat: события воронки (`photo_received → slot_confirmed`) + SQL-отчёт (`docs/LOGGING.md`) для мониторинга конверсии.
- feat: дефолтный follow-up без повторяющейся первой фразы + справочник ключевых слов для продолжения диалога.
- docs: обновлены PRD/SRS, добавлены схемы данных, API-контракты, алгоритм автопланировщика, UX-потоки, правила каталога и логирования.

### Configuration
- `.env.example` дополнен переменными `REMINDER_TICK_MS`, `REMINDER_DEFAULT_DELAY_H`, `AUTOPLAN_MIN_HOURS_AHEAD`, `WEATHER_PROVIDER`, `CATALOG_IMPORT_PATH`.
- добавлен `BOT_HANDLER_TIMEOUT_MS`, чтобы управлять лимитом выполнения хендлеров Telegraf (значение `0`/отрицательное отключает таймаут).

### Fixed
- fix: добавлено уникальное ограничение на `users.tg_id`, чтобы `ON CONFLICT (tg_id)` в bot API не падал в окружениях без индекса.
- fix: Alembic теперь подтягивает core-таблицы (`objects`, `cases`, `plan_stages`, `reminders`, `autoplan_runs` и т.д.) через общий SQL-скрипт, так что бот не падает на `relation ... does not exist`.
- fix: bot перестаёт обрывать обработку фото на 90‑й секунде — таймаут Telegraf теперь настраивается через `BOT_HANDLER_TIMEOUT_MS` (по умолчанию 180 000 мс).
