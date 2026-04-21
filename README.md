# Карманный агроном – Telegram Bot (MVP)

[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/downloads/release/python-3110/)
> Требуется Node.js 20+ для работы Telegram-бота и тестов.

> Минималистичный AI-бот для диагностики болезней растений и рекомендаций по протоколу обработки.  
> Версия API: **v1.10.0** | Документация: в папке `docs/` | OpenAPI: `openapi/openapi.yaml`

---

## 📦 Возможности

- 📷 Приём фото листьев и анализ через GPT‑Vision
- 🧪 Возврат диагноза: `{crop, disease, confidence, reasoning}`
- 🧴 План обработки из GPT: `treatment_plan {product, dosage, phi, safety}`
- ⏰ Блок `next_steps`: напоминание, зелёное окно, CTA из ассистента
- 📋 Протокол обработки из реестра: `{product, dosage_value, dosage_unit, phi}`
- 💬 Живой чат с ИИ‑агрономом: свободные вопросы, обсуждение вариантов, кнопка «📌 Зафиксировать» превращает договорённость в case/plan/event + напоминания
- 🕐 Ограничение FREE_MONTHLY_LIMIT фото/мес на Free-тарифе (по умолчанию 5)
- 💳 Продаёт Pro-доступ через СБП за 199 ₽/мес (Bot Payments 2.0)
- 💸 Paywall при превышении лимита (код 402)
- ⏱️ Бот отслеживает статус платежа и уведомляет об успехе или ошибке
- 📊 Учёт запросов в таблице `photo_usage`, CRON `5 0 1 * *` сбрасывает счётчики
- 📈 Таблица `plan_funnel_events` фиксирует шаги воронки (см. `docs/LOGGING.md`) и помогает отслеживать конверсию «Фото → Время»
- 📜 История снимков (пагинация)
- 📂 API `/v1/diagnoses/recent` отдаёт последний диагноз (24 ч) для повторного планирования
- 🧭 API `/v1/plans/sessions` позволяет сохранять/восстанавливать шаги мастера планов с TTL
- 🔗 Интеграция с партнёром AgroStore
- 🌍 Автоопределение координат по региону (Nominatim + Redis-кеш) для точного прогноза
- 🔔 Автопланер предупреждает, если использует дефолтные координаты, и просит обновить их через /location
- 🕒 Автопланер присылает карточку «Шаг 3/3» с подобранным окном и погодными аргументами; если очередь недоступна, бот создаёт fallback-слот с дефолтной причиной и теми же кнопками `[Принять] / [Выбрать другое время] / [Отменить]`
- 📋 Раздел «Мои планы» показывает ближайшие обработки (с фильтром по объектам и кнопкой «Показать ещё»), отдельный блок «Просроченные» с быстрыми действиями и даёт кнопки `[✅ Выполнено] [🔁 Перенести] [✖ Отменить] [📋 Открыть план]`
- 📣 Если просрочки накапливаются, бот присылает push-уведомление с CTA «📋 Мои планы»
- 🎯 При нескольких объектах бот показывает чипы над клавиатурой — выбор растения занимает один клик
- 🧭 В меню Telegram закреплены команды: `/new`, `/plans`, `/objects`
- 📘 Есть онбординг/демо-план: первые пользователи видят 3 шага, пример плана и подсказки про кнопки «Назад/Отмена»
- 📍 Команда `/location` для обновления координат участка (точнее прогноз «зелёных окон»)

---

### ⏱️ Автоплан и fallback «Шаг 3/3»

1. После выбора варианта (`pick_opt`) запускается `autoplan_run`: воркер (Open‑Meteo + BullMQ) ищет окно и записывает его в `treatment_slots`.
2. Как только окно найдено, бот отправляет карточку:
   ```
   Шаг 3/3. Предлагаю обработку для 🍇 Ежевика — Листовая подкормка.

   🗓 12 ноября, 19:00–20:00

   Почему это окно:
   • без дождя 12 ч
   • ветер до 4 м/с
   • +14…+16 °C
   ```
   Кнопки `[Принять] / [Выбрать другое время] / [Отменить]` управляют слотом и логируют `slot_confirmed`.
3. Если очередь/воркер недоступны, `plan_pick` сразу создаёт fallback-слот: карточка остаётся «Шаг 3/3», но reason заполняется дефолтным текстом («Автопланер сейчас недоступен…»), чтобы пользователь не ждал; сообщение `plan_autoplan_none` дополнено кнопкой «Подобрать время вручную».
4. Кнопка «Выбрать другое время» (или fallback из уведомления) открывает ручной мастер (пресеты «Сегодня вечером», «Завтра утром», «Выбрать дату»). Шаг хранится в `plan_sessions` (`time_manual_prompt → time_scheduled`), поэтому при возврате командой `/plan_treatment` бот повторно показывает актуальную карточку или сообщает, что время уже выбрано.

---

## 💬 Живой ассистент

> **Доступ:** AI-ассистент доступен только для **Pro-подписчиков** или **beta-пользователей**. Free-пользователи видят paywall с предложением оформить Pro.

- Нажмите «💬 Задать вопрос ассистенту» под карточкой диагноза или выполните `/assistant`, чтобы открыть чат — бот подтянет активный объект и последние диагнозы/plans/events.
- Вопросы пишите в свободной форме. Ассистент отвечает одним сообщением и прикладывает `proposals[]` с кнопкой «📌 Зафиксировать». Пока пользователь не подтвердит предложение, данные остаются в чате; после клика бот вызывает `/v1/assistant/confirm_plan`, создаёт plan/events/reminders и присылает CTA «📋 Показать дневник» / «💬 Вернуться к чату».
- При ошибках (`OBJECT_NOT_FOUND`, `PRODUCT_FORBIDDEN`, `PHI_CONFLICT`, `WEATHER_UNAVAILABLE` и др.) используются те же дружелюбные userErrors, что и в мастере планов, так что UX остаётся единым.

## 🗣️ Тон и CTA

- GPT-ассистент говорит дружелюбно («Давай», «Советую», «Обрати внимание») и отвечает чистым JSON без fenced-кода.
- При уверенности ≥ 0.6 CTA — «Добавить обработку» или «Выбрать окно»; при уверенности < 0.6 бот показывает блок «Пересъёмка / уточнить культуру» с инструкциями и ссылкой на поддержку.
- В каждой карточке есть разделы «📸 Диагноз», «🧪 Почему так», «🧴 План», «⏰ Что дальше» и кнопки «Запланировать», «Поставить напоминание PHI», «PDF-заметка».

---

## 🚀 Архитектура

- Backend: **FastAPI** (или Node.js)
- DB: **PostgreSQL 15 + pgvector** (`docker-compose` по умолчанию использует `pgvector/pgvector:pg15`)
- Хранилище: **S3 (VK S3 или MinIO)**
- Очередь: **Bull / Celery / Redis (опционально)**
- Аналитика: **Prometheus, Grafana, Loki**
- Безопасность: per-user `X-API-Key`, `X-API-Ver`, `X-User-ID`, `X-Req-Ts`, `X-Req-Nonce`, `X-Req-Sign`, `X-Req-Body-Sha256`, HMAC‑SHA256
- Живой ассистент — тонкий слой оркестрации: чат остаётся интерфейсом, а «истина» хранится в cases/plans/events и напоминаниях через те же сервисы, что и мастер по фото

---

## 🔐 Лимиты и защита

| Тариф      | Диагнозов в месяц | Защита |
|------------|-------------------|--------|
| Free       | FREE_MONTHLY_LIMIT (по умолчанию 5) | `X-API-Key` + `X-API-Ver` + `X-User-ID` + `X-Req-*` |
| Pro        | ∞                 | —      |

Все эндпоинты валидируются через OpenAPI + Spectral.
Подписи запросов API: `X-Req-Ts` + `X-Req-Nonce` + `X-Req-Sign` (+ `X-Req-Body-Sha256` для JSON) (HMAC‑SHA256 по payload с user_id/ts/nonce/method/path/query/body_sha256).
Подписи от партнёров через `X-Sign` + `signature` в теле (HMAC‑SHA256).
Учёт лимита ведётся в таблице `photo_usage` (user_id, month, used). Сброс счётчиков
производит воркер `usage_reset.js` по CRON `5 0 1 * *` (МСК). При получении
ошибки 402 бот показывает paywall с предложением купить Pro.
Глобальный rate-limit реализован через Redis (`INCR`+`EXPIRE`): 30 req/мин с одного IP и 120 req/мин на `user_id` (для Pro нет ограничений). IP берётся из `request.client.host` или первого адреса в `X-Forwarded-For`, если последний прокси указан в `TRUSTED_PROXIES`. При превышении бот получает 429 и событие фиксируется в логах.
Повторная диагностика `pending/retrying` обрабатывается отдельным сервисом
`retry_diagnosis` (`scripts/retry_diagnosis_runner.py`) в Docker Compose.
Воркер работает циклично с интервалом `RETRY_RUN_INTERVAL_SECONDS` (по умолчанию 60 c),
берёт по `RETRY_BATCH_SIZE` записей за цикл (по умолчанию 20) и прекращает ретраи
после `RETRY_LIMIT` попыток (по умолчанию 3, статус `failed`).
Ротация секретов (`DB_URL`, `BOT_TOKEN_DEV`, `S3_KEY`) выполняется раз в неделю
скриптом `rotate_secrets.ts` (CRON `0 3 * * 0`), который после обновления
секретов выполняет `kubectl rollout restart`.

---

## 📂 Основные эндпоинты

| Метод | URL                       | Описание                      |
|-------|---------------------------|-------------------------------|
| POST  | `/v1/ai/diagnose`         | Диагностика по фото (1 кадр `image` или подборка `images[]` до 8 файлов) |
| GET   | `/v1/photos`              | История снимков               |
| GET   | `/v1/photos/{photo_id}`   | Статус обработки фото         |
| GET   | `/v1/limits`              | Остаток бесплатных запросов  |
| GET   | `/v1/payments/{payment_id}` | Статус платежа и срок PRO    |
| POST  | `/v1/payments/sbp/webhook`| Webhook оплаты Pro            |
| POST  | `/v1/partner/orders`      | Заказ препарата от партнёра  |

OpenAPI см. в `openapi/openapi.yaml`

### Пример запроса `/v1/ai/diagnose`

`X-API-Key` — пользовательский ключ из `users.api_key` (для локальных тестов можно использовать `test-api-key`).
Подпись: HMAC‑SHA256(`user_api_key`, JSON payload `{user_id, ts, nonce, method, path}`).

```bash
TS=$(date +%s)
NONCE=$(python - <<'PY'
import uuid
print(uuid.uuid4().hex)
PY
)
SIGN=$(python - <<PY
import hmac, hashlib, json, os
payload = {
  "user_id": 1,
  "ts": int("$TS"),
  "nonce": "$NONCE",
  "method": "POST",
  "path": "/v1/ai/diagnose",
  "query": "",
}
body_sha256 = hashlib.sha256(
    json.dumps(
        {"image_base64": "dGVzdA==", "prompt_id": "v1"},
        separators=(",", ":"),
        sort_keys=True,
        ensure_ascii=False,
    ).encode()
).hexdigest()
payload["body_sha256"] = body_sha256
body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
key = os.environ.get("API_KEY", "test-api-key").encode()
print("BODY_SHA256=" + body_sha256)
print(hmac.new(key, body, hashlib.sha256).hexdigest())
PY
)
```

```bash
curl -X POST http://localhost:8010/v1/ai/diagnose \
  -H "X-API-Key: $API_KEY" \
  -H "X-API-Ver: v1" \
  -H "X-User-ID: 1" \
  -H "X-Req-Ts: $TS" \
  -H "X-Req-Nonce: $NONCE" \
  -H "X-Req-Sign: $SIGN" \
  -H "X-Req-Body-Sha256: $BODY_SHA256" \
  -H "Content-Type: application/json" \
  -d '{"image_base64":"dGVzdA==","prompt_id":"v1"}'
```

Ответ:

```json
{
  "crop": "apple",
  "disease": "powdery_mildew",
  "confidence": 0.92,
  "roi": 1.9,
  "reasoning": "Белый мучнистый налёт на молодых листьях и скручивание края.",
  "treatment_plan": {
    "product": "Топаз",
    "dosage": "2 мл на 10 л воды (опрыскивание по листу)",
    "phi": "30 дней",
    "safety": "Перчатки и респиратор, не обрабатывать при ветре"
  },
  "next_steps": {
    "reminder": "Повторить обработку через 7 дней и отметить PHI",
    "green_window": "Выбери вечер без дождя и ветра >5 м/с",
    "cta": "Добавить обработку"
  },
  "protocol_status": null,
  "protocol": {
    "product": "Скор 250 ЭК",
    "dosage_value": 2.0,
    "dosage_unit": "ml_10l",
    "phi": 30
  }
}
```

---

## 🧱 Структура проекта

agronom-bot/
├── app/ # Основной код
│ ├── controllers/ # Контроллеры FastAPI
│ ├── models/ # Pydantic/SQLAlchemy схемы
│ └── services/ # GPT, подписи, S3
├── docs/ # SRS, ADR, Test Plan и др.
├── prompts/ # Промты для Cursor/GPT
├── openapi/ # API спецификация (OpenAPI.yaml)
├── migrations/ # Alembic
├── tests/ # Тесты (pytest)
├── .env.template # Пример переменных окружения
└── README.md # Этот файл



## 🛠️ Установка и запуск локально

Перед началом убедитесь, что у вас установлен **Node.js 20+** (бот и его тесты используют optional chaining/ES2022). Если системный `node` ниже, установите LTS 20 и добавьте его в `PATH` или запустите `npm test --prefix bot` через бинарник `node20`.

### Важно: Docker-окружение

Если в `.env` используются хосты сервисов из `docker-compose` (например, `db`, `redis`, `minio`), запускайте миграции и интеграционные проверки **внутри контейнеров**:

```bash
docker compose up -d db redis minio api bot
docker compose exec api alembic upgrade head
docker compose exec api pytest
docker compose exec bot npm test --prefix bot
```

Запуск `alembic upgrade head` из хоста с таким `.env` обычно падает из-за DNS (`could not translate host name "db"`), потому что имя `db` резолвится только внутри docker-сети.

Для RAG слой `pgvector` обязателен. Быстрая проверка в БД:

```sql
SELECT extname FROM pg_extension WHERE extname='vector';
```

1. Скопируйте файл шаблона переменных окружения командой `cp .env.template .env` и укажите параметры подключения к БД и S3. Минимально нужны (обязательно задайте `POSTGRES_PASSWORD` в `.env`):

   ```env
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=your-postgres-password
   POSTGRES_DB=agronom
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   DATABASE_URL=postgresql://postgres:your-postgres-password@localhost:5432/agronom
   BOT_DATABASE_URL=postgresql://postgres:your-postgres-password@localhost:5432/agronom
API_BASE_URL=http://localhost:8010

   S3_BUCKET=agronom
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minio
   S3_SECRET_KEY=minio123
   REDIS_URL=redis://localhost:6379
   RETRY_LIMIT=3
   RETRY_BATCH_SIZE=20
   RETRY_RUN_INTERVAL_SECONDS=60
   ```

`DATABASE_URL` и `BOT_DATABASE_URL` поддерживают форматы `postgresql://` и
`postgresql+<driver>://` (например, `postgresql+psycopg://`). Скрипт
`migrate_safe.sh` автоматически преобразует такие DSN к виду
`postgresql://` перед передачей в `psql`.

`postgres` и `api` — это имена сервисов в `docker-compose.yml`.
Они разрешаются только внутри сети Docker Compose. Если запускать API и бот
на хост‑машине без Docker, используйте `localhost`:

```env
BOT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom
API_BASE_URL=http://localhost:8010
```

Чтобы обращаться к сервисам по имени, сперва поднимите контейнеры:

```bash
docker-compose up -d
# после этого доступны DSN с именами сервисов
BOT_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/agronom
API_BASE_URL=http://api:8010
```

Если при подключении появляются ошибки DNS вроде `EAI_AGAIN`, проверьте, что
контейнеры запущены, используйте `localhost`/`127.0.0.1` для приложений вне
Docker и при необходимости очистите DNS‑кеш (`sudo systemd-resolve --flush-caches`).

> ℹ️ Если вы задаёте `HTTP_PROXY`/`HTTPS_PROXY` (например, чтобы Telegram‑бот
> ходил в интернет), обязательно пропишите `NO_PROXY=localhost,127.0.0.1,api,bot,db,redis,minio,prometheus,loki,grafana`
> или расширьте существующее значение. Иначе внутренние сервисы (MinIO, Postgres,
> Redis) будут ходить через внешний прокси и возвращать 502/timeout.

2. Создайте виртуальное окружение под **Python 3.11+ (3.12 experimental)** (в нём уже есть SQLite 3.35+):

   ```bash
   python3.11 -m venv .venv
   source .venv/bin/activate
   ```

   Требуется SQLite версии **3.35+**, иначе не будут работать некоторые запросы к БД.


**Потребуется Node.js 18+** — используется для Telegram‑бота и тестов.
Подпроекты `bot` и `fastify` содержат поле `"engines": { "node": ">=18" }` и
файл `.npmrc` с `engine-strict=true`, поэтому `npm install` проверит версию Node.

3. Установите зависимости командой `./.codex/setup.sh` и дополнительные пакеты для тестов из `requirements-dev.txt`. После этого установите Node-зависимости (`spectral` и прочие) командой `npm install`. Команду `pip install -r ./requirements-dev.txt` запускайте **из корня репозитория**. Перед запуском приложения обязательно задайте `DATABASE_URL` и примените миграции:

   ```bash
   ./.codex/setup.sh
   pip install -r ./requirements-dev.txt
   npm install
   export DATABASE_URL=sqlite:///./app.db  # или другая строка подключения
   # безопасное применение миграций
   ./scripts/migrate_safe.sh
   # посмотреть план без выполнения
   ./scripts/migrate_safe.sh --dry-run
   ```
   Скрипт автоматически определяет тип БД по `DATABASE_URL`. Если используется
   `sqlite://`, проверка `psql` пропускается, и сразу выполняется
   `alembic upgrade head`.
### 🛠 Troubleshooting миграций

Использование `DB_CREATE_ALL=1` создаёт таблицы без истории Alembic. Если база была создана таким образом, при миграции можно получить ошибку «duplicate column name».

**Вариант A.** Удалите файл базы (например, `app.db`) и запустите `./scripts/migrate_safe.sh` вновь.  
**Вариант B.** Если таблицы уже совпадают с актуальной схемой, выполните `alembic stamp head`, а затем применяйте миграции.

Так база синхронизируется с Alembic и дальнейшие обновления пройдут без ошибок.

### 📚 RAG bootstrap (новый стенд)

Порядок для нового окружения:

1. Примените миграции:
   ```bash
   alembic upgrade head
   ```
2. Проверьте preflight (БД доступна, `vector` extension, таблица `knowledge_chunks`):
   ```bash
   python scripts/rag_preflight.py --database-url "$DATABASE_URL"
   ```
3. Загрузите корпус знаний:
   ```bash
   python scripts/load_knowledge_chunks.py \
     --database-url "$DATABASE_URL" \
     --manifest load/rag_houseplants_seed_2026_02_24/manifest.csv \
     --only-new
   ```
   Скрипт печатает итоговый отчёт: `inserted/updated/skipped/failed`.
4. Выполните smoke retrieval:
   ```bash
   python scripts/rag_smoke_check.py \
     --database-url "$DATABASE_URL" \
     --query "трипсы на комнатных растениях" \
     --min-hits 1
   ```

Короткий runbook по проверке `pgvector`: `runbooks/rag_pgvector.md`.

4. Запустите API:

   ```bash
   uvicorn app.main:app --reload
   ```

5. Запустите Telegram‑бота (не забудьте указать токен и ссылку партнёра в `.env`):
   **Требуется Node.js 18+**
   В файл `.env` добавьте переменные:

   - `BOT_TOKEN_PROD=ваш_токен_бота` (для продакшена; если не задан, будет использован `BOT_TOKEN_DEV`)
   - `BOT_TOKEN_DEV=ваш_токен_бота` (для dev/stage)
   - `PARTNER_LINK_BASE=https://agrostore.ru/agronom`
   - `PAYWALL_ENABLED=true`  # включить показ paywall
   - `BOT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom`  # строка подключения для бота (в Docker: postgres)
   - `API_BASE_URL=http://localhost:8010`  # адрес API (в Docker: http://api:8010)
   - `BOT_METRICS_PORT=9300`  # порт Prometheus-метрик бота (по умолчанию 3000, поменяйте если Grafana уже слушает на этом порту)
   - `FREE_PHOTO_LIMIT=5`  # число бесплатных фото в месяц для Telegram-бота ([пример](.env.template#L89))
   - `TINKOFF_TERMINAL_KEY=your-terminal-key`
   - `TINKOFF_SECRET_KEY=your-secret-key`
   - `HMAC_SECRET_PARTNER=test-hmac-partner`  # подпись AgroStore
   - `REFRESH_COLLATION_ON_START=1`  # при старте API выполнит ALTER DATABASE … REFRESH COLLATION VERSION (установите 0, если нет прав)

  Бот подключается к PostgreSQL по DSN из `BOT_DATABASE_URL`.

   ```bash
   npm install --prefix bot
   node bot/index.js
   ```

   Базовые команды:

   - `/start` — подсказка отправить фото листа
   - `/retry <id>` — повторить диагностику
- отправьте фото, чтобы получить диагноз и кнопку с протоколом
- после оплаты бот уведомит о результате и сроке PRO

6. Запустите автопланер — он обрабатывает очередь BullMQ и подбирает «зелёные окна» после выбора опций в плане. Убедитесь, что заданы `BOT_DATABASE_URL`, `REDIS_URL`, `BOT_TOKEN_PROD` (или `BOT_TOKEN_DEV`) и координаты по умолчанию (`WEATHER_LAT`/`WEATHER_LON`):

   ```bash
   node worker/autoplan.js
   # или в Docker
   docker compose up -d autoplan
   ```

   В Docker Compose этот воркер использует образ из `worker/Dockerfile` и подключается к той же БД, что и бот.

### 📍 Координаты участка

Чтобы автопланер подбирал окна по реальной погоде, укажите локацию каждого объекта:

- Когда бот присылает карточку «Не нашёл точные координаты…», нажмите кнопку `📍 Геолокация` и отправьте точку через меню вложений Telegram (`📎 → Геопозиция` → «Отправить текущую» или «Выбрать на карте»).
- Либо введите точные координаты командой `/location 55.7512 37.6184`.
- Можно написать адрес текстом — бот попытается найти его через геосервис.

Пока координаты не заданы, автопланер использует дефолт из `.env`, поэтому окна и уведомления будут неточными.

7. Тесты запускаются командой:

   ```bash
   pytest
   ```

   При отсутствии переменной окружения `DATABASE_URL` тесты используют
    SQLite файл `./app.db`.

   Для запуска тестов нужна SQLite **3.35+** – на старых версиях не работает
   `RETURNING`, и часть тестов завершится ошибкой.

    Тесты игнорируют файл `.env`, так как `Settings(_env_file=None)` передаётся в
    хранилище. Локальные переменные вроде `S3_ENDPOINT` не повлияют на результат.

### Асинхронный доступ к БД

Эндпоинты FastAPI работают в асинхронном режиме. Чтобы не блокировать
event loop, оборачивайте синхронный `SessionLocal` в `asyncio.to_thread` или
используйте асинхронный движок SQLAlchemy.

```python
def _db_task():
    with db.SessionLocal() as session:
        session.add(obj)
        session.commit()

await asyncio.to_thread(_db_task)
```

7. Проверьте спецификацию OpenAPI линтером Spectral:

   ```bash
   spectral lint -r .spectral.yaml openapi/openapi.yaml
   ```

### AI-оркестратор проверок (авто/вручную)

Для автоподбора проверок по изменённым путям используйте:

```bash
./scripts/agent_orchestrator.sh        # auto: по git diff
./scripts/agent_orchestrator.sh all    # полный прогон
```

Скрипт запускает нужные проверки для backend/bot/openapi/RAG и напоминает про синхронизацию docs.  
В CI этот же сценарий запускается через workflow `.github/workflows/agent-orchestrator.yml`.

8. Быстро поднять всю инфраструктуру можно командой `docker-compose up -d`. После запуска сервис Grafana будет доступен на [http://localhost:3000](http://localhost:3000). По умолчанию логин и пароль `admin`/`admin`. При необходимости укажите переменные `GF_SECURITY_ADMIN_USER` и `GF_SECURITY_ADMIN_PASSWORD` в `.env`.


### Импорт протоколов обработки

Для обновления справочника обработок используйте утилиту:

```bash
python -m app.services.protocol_importer <zip_url> --category main
```

Добавьте флаг `--force`, чтобы перезаписать существующие данные. Скрипт
сохраняет CSV и заполняет таблицы `catalogs` и `catalog_items`.
В продакшене утилита запускается ежемесячным CRON‑джобом для актуализации
протоколов.

Если сервер каталога использует самоподписанный сертификат, задайте путь к
файлу доверенного сертификата через переменную окружения
`CATALOG_CA_BUNDLE`.  Чтобы полностью отключить проверку TLS, установите
`CATALOG_SSL_VERIFY=false`. Обе переменные добавлены в `.env.template`.

### Ежемесячные задачи CRON

- `python -m app.services.protocol_importer` — обновляет таблицы `catalogs` и
  `catalog_items`.
- `usage_reset.js` — сбрасывает счётчики в таблице `photo_usage` по расписанию
  `5 0 1 * *` (МСК).

### ⚙️ Миграция на Python 3.11+ (3.12 experimental)

1. Удалите старое окружение `.venv` (если было):

   ```bash
   rm -rf .venv
   ```

2. Пересоздайте виртуальное окружение и переустановите зависимости:

   ```bash
   python3.11 -m venv .venv
   source .venv/bin/activate
   ./.codex/setup.sh
   ```
📖 Документация
Смотри в папке docs/:

srs.md — системные требования

adr.md — архитектура

data_contract.md — схема БД

security_checklist.md — безопасность

partner_agrostore.md — интеграция партнёра

[pricing.md](pricing.md) — тарифы и способы оплаты
payment_flow.md — процесс оплаты и webhook SBP
[docs/public_offer.md](docs/public_offer.md) — публичная оферта
[privacy_policy.md](docs/privacy_policy.md) — политика конфиденциальности


## Release 1.0 maintenance

Bug fixes that must go into the `release/1.0.0` branch should be labeled `release-blocker` so they can be tracked before the final release.


## License

This project is licensed under the [MIT License](LICENSE).
