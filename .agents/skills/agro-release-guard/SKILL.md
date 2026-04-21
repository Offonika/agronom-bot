---
name: agro-release-guard
description: "Выполняй pre-PR и pre-release контроль качества в agronom-bot. Используй перед созданием PR в develop, перед релизным тегом или после крупной серии изменений, чтобы проверить тесты, линтеры, миграции, контракт и документацию."
---

# Agro Release Guard

## Scope

- Применяй skill как финальный quality-gate перед PR/релизом.
- Используй для проверки целостности backend, bot и документации в одном проходе.

## Verification Workflow

1. Собери поверхность изменений:
- `git status --short`
- `git diff --name-only`
2. Запусти обязательные проверки:
- `./venv/bin/ruff check app tests`
- `./venv/bin/python -m pytest`
- `npm test --prefix bot`
- `alembic upgrade head` (если есть изменения схемы/миграций)
3. Проверь API-контракт и спецификации:
- `spectral lint openapi/openapi.yaml`
- Выполни `openapi-diff` с базовой веткой, если утилита доступна в окружении
4. Проверь документацию:
- `docs/srs.md`
- `docs/data_contract.md`
- `docs/payment_flow.md` при платежных изменениях
- `CHANGELOG.md` (semver и описание изменений)
5. Проверь готовность PR:
- Целевая ветка: `develop`
- Тип PR: `[feature]`, `[fix]`, `[refactor]` или `[docs]`
- Шаги воспроизведения и проверки описаны
6. Подготовь итоговый отчёт:
- Pass/Fail по каждому чеку
- Блокеры и риски
- Список команд, которые не удалось выполнить

## Guardrails

- Не маскируй пропущенные проверки: явно отмечай `not run` и причину.
- Не пропускай обновление docs при изменении логики или API.
- Не включай в коммиты реальные секреты и токены.
