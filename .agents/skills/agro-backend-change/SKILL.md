---
name: agro-backend-change
description: "Выполняй backend-изменения в agronom-bot: FastAPI роуты, сервисы, модели SQLAlchemy, миграции Alembic и backend-контракты. Используй, когда задача затрагивает app/, migrations/, openapi/ или меняет поведение API/данных."
---

# Agro Backend Change

## Scope

- Применяй skill для Python/FastAPI части репозитория.
- Не применяй для чисто фронтовых или чисто Telegram-bot задач без backend-изменений.

## Workflow

1. Открывай `tasks.md` перед началом и учитывай приоритеты; при прямом запросе пользователя выполняй запрос, не теряя чеклист качества.
2. Определи область влияния до правок:
- API-роуты и схемы (`app/controllers`, `app/models`, `openapi/openapi.yaml`).
- Данные и миграции (`migrations/versions`, ограничения, индексы).
- Сервисы и интеграции (`app/services`).
3. Вноси минимально достаточные изменения без побочных рефакторингов.
4. Обновляй документацию при изменении поведения/контракта:
- `docs/srs.md`
- `docs/data_contract.md`
- `docs/payment_flow.md` при платежных изменениях
- `CHANGELOG.md` (semver)
5. Запускай проверки:
- `./venv/bin/ruff check app tests`
- `./venv/bin/python -m pytest`
- `alembic upgrade head` при изменениях схемы
- `spectral lint openapi/openapi.yaml` при изменениях OpenAPI
6. Формируй финальный отчёт:
- Что изменено и почему.
- Какие команды запущены и их итог.
- Какие проверки не запускались и почему.
- Риски и ограничения.

## Guardrails

- Не выполняй блокирующие DB-вызовы внутри async-хендлеров FastAPI.
- Не коммить секреты и реальные токены.
- Не откатывай чужие изменения без прямого запроса пользователя.
