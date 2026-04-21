AGENTS.md — Contributor Guide для Codex/AI-агентов

Version 1.3 — 4 March 2026 (v1.2 -> v1.3: architecture overview, формальный DoD, AI/security/CI policy, уточнение worker/BullMQ)
Всегда отвечай на русском в чатах.

## Quick English Overview
- Python 3.11+ (3.12 experimental) for FastAPI API.
- Node.js 20+ for Telegram bot and BullMQ workers.
- Default PR target: `develop`.
- Run relevant linters/tests before PR and update docs when behavior/contracts change.

## Оглавление
1. [System Architecture Overview](#system-architecture-overview)
2. [Каталог и зоны ответственности](#каталог-и-зоны-ответственности)
3. [Быстрый старт и команды](#быстрый-старт-и-команды)
4. [Переменные окружения](#переменные-окружения)
5. [Definition of Done (DoD)](#definition-of-done-dod)
6. [AI-agent coding rules](#ai-agent-coding-rules)
7. [Security rules](#security-rules)
8. [Worker/BullMQ](#workerbullmq)
9. [Тесты и линтинг по типу изменений](#тесты-и-линтинг-по-типу-изменений)
10. [Правила PR и документации](#правила-pr-и-документации)
11. [CI failure policy](#ci-failure-policy)
12. [Работа с tasks.md](#работа-с-tasksmd)
13. [Внешние сервисы](#внешние-сервисы)
14. [Контакты](#контакты)

## System Architecture Overview
```text
Telegram User
   |
   v
Telegram Bot (Node.js, Telegraf, bot/)
   | \
   |  \--> Redis (BullMQ queues)
   v
FastAPI API (app/controllers)
   v
Services layer (app/services) ---> MinIO/S3 (файлы)
   |
   +---------------------------> PostgreSQL (данные)
   |
   +---------------------------> Redis (кеш, rate limit, state)

BullMQ Workers (Node.js, worker/*.js) <--- Redis queues
   |
   +--> PostgreSQL (обновление планов/состояний)
   +--> Telegram API (уведомления пользователю)
```

Роли слоёв:
- `app/controllers/`: FastAPI-роуты, валидация входа/выхода, HTTP-контракты.
- `app/services/`: бизнес-логика (диагностика, планы, платежи, квоты, интеграции).
- `app/models/`: SQLAlchemy-модели и Pydantic-схемы.
- `bot/src/`: Telegram UX-сценарии, callback/state-flow, локализация.
- `worker/`: фоновые Node.js job-воркеры (BullMQ) для автоплана, reset usage и связанных задач.
- Redis/BullMQ используется как транспорт очередей; Postgres — source of truth.

## Каталог и зоны ответственности
```text
app/
  controllers/   # FastAPI routers
  models/        # SQLAlchemy + Pydantic
  services/      # GPT, S3, payments, quotas, queue producers
bot/
  src/           # Telegram bot commands/flows
  tests/         # Bot tests
worker/          # Node.js BullMQ workers + worker tests
openapi/
  openapi.yaml   # synced with FastAPI schema
tests/           # PyTest backend tests
```

Важно: актуальные BullMQ-воркеры лежат в `worker/` (Node.js). `app/services/*` содержит Python-часть API и продюсеры/интеграции, а не отдельный Node worker runtime.

## Быстрый старт и команды
Сначала скопируйте `.env.template` -> `.env` и заполните значения.

### Локальный запуск (без docker-compose)
```bash
# Python deps (используйте venv, Python 3.11+)
./venv/bin/pip install -r requirements.txt

# Node deps для bot
npm ci --prefix bot

# (опционально) Node deps верхнего уровня для worker/tests
npm ci

# Миграции
./venv/bin/alembic upgrade head

# API
./venv/bin/uvicorn app.main:app --reload

# Bot
node bot/index.js

# BullMQ worker (пример: автоплан)
node worker/autoplan.js
```

### Если `.env` настроен под docker-compose (хосты `db/redis/minio/api`)
Запускайте миграции и интеграционные тесты только в контейнерах:

```bash
docker compose up -d db redis minio api bot autoplan
docker compose exec api alembic upgrade head
docker compose exec api pytest
docker compose exec bot npm test --prefix bot
```

Запуск `alembic upgrade head` с хоста при таком `.env` приводит к ошибке резолва `db`.

## Переменные окружения
Never commit real tokens. Используйте GitHub Secrets в CI/CD.

| Var | Purpose | Required | Example / Notes |
|---|---|---|---|
| `POSTGRES_*` | Параметры PostgreSQL | Да (docker-compose) | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| `DATABASE_URL` | Подключение API/Alembic к БД | Да | Для миграций и backend runtime |
| `BOT_DATABASE_URL` | Отдельный DSN для bot/worker | Рекомендуется | Если не задан, используется `DATABASE_URL` |
| `REDIS_URL` | Redis для state/rate-limit/BullMQ | Да (bot/worker) | `redis://redis:6379` в compose |
| `S3_ENDPOINT` | S3/MinIO endpoint | Да (если включено файловое хранилище) | В dev обычно MinIO |
| `S3_ACCESS_KEY` | Ключ S3/MinIO | Да (если S3 включен) | Не логировать |
| `S3_SECRET_KEY` | Секрет S3/MinIO | Да (если S3 включен) | Не логировать |
| `BOT_TOKEN_DEV` | Telegram token для dev/stage | Да (dev) | Используется ботом/воркером |
| `BOT_TOKEN_PROD` | Telegram token для prod | Да (prod) | В dev можно не задавать |
| `BOT_METRICS_PORT` | Порт метрик бота | Нет | По умолчанию `3000`; измените, если порт занят |
| `API_BASE_URL` | URL backend API для бота | Да (bot runtime) | Локально `http://localhost:8010`, в compose `http://api:8010` |
| `SUPPORT_CHAT_ID` | ID чата поддержки для `/support` | Нет | Может быть отрицательным для супергрупп |
| `OPENAI_API_KEY` | Ключ GPT-Vision (sandbox) | Да (диагноз) | Никогда не коммитить |
| `TINKOFF_TERMINAL_KEY` | Tinkoff SBP terminal key | Да (если включен SBP/Tinkoff) | Для invoice/autopay |
| `TINKOFF_SECRET_KEY` | Tinkoff secret key | Да (если включен SBP/Tinkoff) | Для подписи/статусов |
| `HMAC_SECRET_PARTNER` | Подпись интеграции AgroStore | Да (partner flow) | Хранить только в secret store |

## Definition of Done (DoD)
Задача считается завершённой только если выполнены все применимые пункты:
1. Код реализует задачу полностью, без незапрошенных рефакторингов.
2. Для багфикса добавлен/обновлён минимум один тест, ловящий регрессию.
3. Прогнаны релевантные проверки (см. матрицу ниже: `ruff`, `pytest`, `npm test`, миграции).
4. При изменении схемы БД: есть Alembic migration и она применима (`alembic upgrade head`).
5. При изменении API-контрактов: обновлены `openapi/openapi.yaml`, выполнены `spectral lint` и `openapi-diff` (когда применимо).
6. Обновлены документы, если меняется поведение/контракт (`docs/srs.md`, `docs/data_contract.md`, профильные flow-доки, при необходимости `CHANGELOG.md`).
7. В PR явно перечислено: что изменено, как проверить, какие проверки запускались.
8. Если что-то не запускалось локально, это явно отмечено в PR: `not run locally` с причиной.
9. Секреты и персональные данные не попали в код, логи, PR и артефакты.
10. Для docs-only изменений допустимо не запускать кодовые тесты, но в PR обязательно указать: `docs-only, code not executed locally`.

## AI-agent coding rules
1. Работайте маленькими PR: один смысловой инкремент на задачу.
2. Делайте атомарные коммиты с понятным intent; не смешивайте unrelated changes.
3. Не рефакторьте несвязанные файлы "попутно".
4. Следуйте существующим паттернам проекта (структура модулей, нейминг, стиль тестов).
5. Любой багфикс должен сопровождаться тестом или объяснением, почему тест невозможен.
6. Изменилось поведение или контракт: синхронизируйте docs/openapi/changelog в этой же задаче.
7. Перед началом берите следующий незакрытый пункт из `tasks.md` по приоритету.
8. Если задача заблокирована: добавьте под ней пометку `⚠ blocked: причина, дата`.

## Security rules
1. Никогда не коммитьте реальные токены/ключи/пароли; в репозитории только шаблоны (`.env.template`).
2. Никогда не публикуйте секреты в логах, PR, issue, чатах и скриншотах CI.
3. Маскируйте чувствительные значения при логировании (`***`/redaction), включая DSN, токены, HMAC-секреты.
4. Не копируйте содержимое локального `.env` в код, документацию и обсуждения.
5. Для CI/CD храните секреты только в GitHub Secrets/секрет-менеджере.
6. При подозрении на утечку: немедленная ротация ключей + запись инцидента в PR/issue без раскрытия секрета.

## Worker/BullMQ
- BullMQ jobs относятся к Node-части и находятся в `worker/`.
- Основные entrypoints: `worker/autoplan.js`, `worker/usage_reset.js` (и сопутствующие `*.test.js`).
- Python API взаимодействует с очередями через `app/services` (например, продюсеры задач), но не исполняет BullMQ-воркеры.
- Запуск локально: `node worker/autoplan.js`.
- Запуск в compose: `docker compose up -d autoplan`.
- Тесты worker входят в корневой `npm test` (`node --test bot/handlers.test.js worker/*.test.js`).

Guidance без рефакторинга (на будущее):
- Целевая структура может быть `worker/jobs`, `worker/queues`, `worker/lib`, но текущий layout менять не требуется без отдельной задачи.

## Тесты и линтинг по типу изменений
Используйте Python из `venv` (системный Python 3.8 не подходит).

| Тип изменений | Минимум проверок |
|---|---|
| Backend (`app/`, `tests/`) | `./venv/bin/ruff check app tests` + `./venv/bin/python -m pytest` |
| Bot JS (`bot/`) | `npm test --prefix bot` |
| Worker JS (`worker/`, общие JS-сервисы) | `npm test` |
| Миграции/схема БД | `./venv/bin/alembic upgrade head` (или `docker compose exec api alembic upgrade head`) |
| OpenAPI/контракт | `spectral lint openapi/openapi.yaml` + `openapi-diff` |
| Docs-only | Можно не гонять кодовые тесты, но явно указать в PR `docs-only, code not executed locally` |

Асинхронные FastAPI handlers не должны выполнять блокирующие DB-вызовы напрямую: используйте SQLAlchemy async session или `asyncio.to_thread`.

## Правила PR и документации
- Ветвление: `feature/...` -> PR -> `develop`.
- Каждый PR должен проходить CI: lint -> tests -> build docker -> openapi-diff.
- При изменениях схемы данных обязательно обновляйте:
  - `docs/data_contract.md`
  - `docs/srs.md`
  - `docs/payment_flow.md` (если затронуты платежные сценарии)
- При изменении пользовательского поведения/флоу обновляйте профильные документы (`docs/prd.md` и др.).
- Обновляйте `CHANGELOG.md` по semver при изменениях поведения/API.
- Шаблон PR description:
  - `Type`: `[feature]` / `[fix]` / `[refactor]` / `[docs]`
  - `What changed` + `Steps to test`
  - `Linked issues`
  - `Executed checks` / `Not run locally` (если есть)

## CI failure policy
1. Сначала воспроизведите упавший шаг локально той же командой.
2. Исправляйте причину, а не обходите проблему (`skip`, `xfail`, отключение lint без обоснования запрещены).
3. Если упали миграции: проверьте порядок ревизий и совместимость upgrade; добавьте недостающую миграцию.
4. Если упал `openapi-diff`/`spectral`: синхронизируйте `openapi/openapi.yaml` с фактическим API и зафиксируйте intentional breaking change в PR.
5. Если не можете воспроизвести локально: приложите лог CI и минимум 2 гипотезы/пути решения в комментарии к PR.
6. Не мерджить PR с красным CI, кроме явно согласованного hotfix-процесса с Tech Lead.

## Работа с tasks.md
1. Открывай `tasks.md` перед началом. Бери следующий незакрытый пункт сверху вниз, учитывая приоритет (High -> Medium -> Low). Не прыгай к backlog, пока текущие приоритеты не закрыты или не заблокированы.
2. Работай последовательно: один активный пункт -> DoD выполнен (код + доки + тесты) -> переходишь к следующему.
3. Для новых фич бота/флоу обновляй документацию: `docs/srs.md` (Scope/FR), `docs/data_contract.md` (минимум/валидаторы/лимиты), профильные flow-доки (`docs/payment_flow.md`, `docs/prd.md` и т.п.).
4. Если блок/зависимость: добавь под задачей пометку `⚠ blocked: причина, дата`, не меняя формулировку задачи.
5. Для фич мультифото/диагноза держи лимит 3-8 фото и чеклист: общий вид + лист лицевая + лист изнанка (обязательно), плод/цветок/корень (опционально). При отклонениях обновляй SRS/Data Contract и локали.
6. Тестовый минимум:
   - backend: `./venv/bin/ruff check app tests` + `./venv/bin/python -m pytest`
   - bot: `npm test --prefix bot`
   - migrations: `./venv/bin/alembic upgrade head` (или через `docker compose exec api ...` при compose-hosts в `.env`)

## Внешние сервисы
- GPT-Vision: sandbox key.
- S3/MinIO: локальный MinIO для dev.
- Tinkoff SBP: sandbox окружение.
- AgroStore: mock server (`make start-partner-mock`).

## Контакты
| Role | Handle |
|---|---|
| Product Owner | `@gromov_agro` |
| Tech Lead | `@your_techlead` |
| QA Lead | `@qa_agro` |
