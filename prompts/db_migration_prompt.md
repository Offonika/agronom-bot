# DB Migration Prompt

Все миграции создаются через Alembic.

Структура таблиц берётся из `docs/data_contract.md`:
- Таблица `photos` включает поля: id, user_id, crop, disease, confidence, ts

Каждая миграция должна:
- иметь semver в имени (например, `2025_07_20_01_init.py`)
- создавать индекс, если описан в контракте (например, `photos_user_ts(user_id, ts DESC)`)

