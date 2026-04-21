---
name: agro-openapi-contract-guard
description: "Проверяй и защищай API-контракт agronom-bot: синхронизацию OpenAPI, lint спецификации и контроль breaking changes перед PR/release."
---

# Agro OpenAPI Contract Guard

## Scope

- Применяй skill при изменениях backend API, схем ответов/запросов, кодов ошибок и совместимости клиентов.
- Не применяй, если правки не затрагивают API-контракт.

## Workflow

1. Определи, затронут ли контракт:
- роуты/handlers/схемы в `app/`
- `openapi/openapi.yaml`
2. Сверь спецификацию и код:
- обнови `openapi/openapi.yaml`, если код изменился
- проверь, что примеры/enum/required соответствуют модели
3. Запусти проверки контракта:
- `spectral lint openapi/openapi.yaml`
- `openapi-diff` с базовой веткой, если инструмент доступен
4. Классифицируй изменения:
- non-breaking: новые optional поля/endpoint
- potentially breaking: удаление/переименование поля, изменение типа, ужесточение required/валидаторов
5. Для breaking изменений подготовь явное описание миграции клиентов в PR/CHANGELOG.

## Guardrails

- Не допускай тихих breaking changes без явной фиксации.
- Не публикуй OpenAPI со схемами, которых нет в runtime.
- Если toolchain недоступен локально, укажи это явно как `not run`.
