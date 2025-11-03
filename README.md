# Карманный агроном – Telegram Bot (MVP)

[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-blue)](https://www.python.org/downloads/release/python-3110/)
> Требуется Node.js 18+ для работы Telegram-бота и тестов.

> Минималистичный AI-бот для диагностики болезней растений и рекомендаций по протоколу обработки.  
> Версия API: **v1.10.0** | Документация: в папке `docs/` | OpenAPI: `openapi/openapi.yaml`

---

## 📦 Возможности

- 📷 Приём фото листьев и анализ через GPT‑Vision
- 🧪 Возврат диагноза: `{crop, disease, confidence}`
- 📋 Протокол обработки: `{product, dosage_value, dosage_unit, phi}`
- 🕐 Ограничение FREE_MONTHLY_LIMIT фото/мес на Free-тарифе (по умолчанию 5)
- 💳 Продаёт Pro-доступ через СБП за 34 900 ₽/мес (Bot Payments 2.0)
- 💸 Paywall при превышении лимита (код 402)
- ⏱️ Бот отслеживает статус платежа и уведомляет об успехе или ошибке
- 📊 Учёт запросов в таблице `photo_usage`, CRON `5 0 1 * *` сбрасывает счётчики
- 📜 История снимков (пагинация)
- 🔗 Интеграция с партнёром AgroStore

---

## 🚀 Архитектура

- Backend: **FastAPI** (или Node.js)
- DB: **PostgreSQL**
- Хранилище: **S3 (VK S3 или MinIO)**
- Очередь: **Bull / Celery / Redis (опционально)**
- Аналитика: **Prometheus, Grafana, Loki**
- Безопасность: `X-API-Key`, `X-API-Ver`, `X-User-ID`, `X-Sign`, HMAC‑SHA256

---

## 🔐 Лимиты и защита

| Тариф      | Диагнозов в месяц | Защита |
|------------|-------------------|--------|
| Free       | FREE_MONTHLY_LIMIT (по умолчанию 5) | `X-API-Key` + `X-API-Ver` + `X-User-ID` |
| Pro        | ∞                 | —      |

Все эндпоинты валидируются через OpenAPI + Spectral.
Подписи от партнёров через `X-Sign` + `signature` в теле (HMAC‑SHA256).
Учёт лимита ведётся в таблице `photo_usage` (user_id, month, used). Сброс счётчиков
производит воркер `usage_reset.js` по CRON `5 0 1 * *` (МСК). При получении
ошибки 402 бот показывает paywall с предложением купить Pro.
Глобальный rate-limit реализован через Redis (`INCR`+`EXPIRE`): 30 req/мин с одного IP и 120 req/мин на `user_id` (для Pro нет ограничений). IP берётся из `request.client.host` или первого адреса в `X-Forwarded-For`, если последний прокси указан в `TRUSTED_PROXIES`. При превышении бот получает 429 и событие фиксируется в логах.
Очередь повторной диагностики запускается скриптом `retry_diagnosis.js`
по CRON из переменной `RETRY_CRON` (по умолчанию `0 1 * * *`) и
обрабатывает задачи с параллелизмом из `RETRY_CONCURRENCY` (по умолчанию `1`).
После трёх неудачных попыток (`RETRY_LIMIT=3`) статус снимка меняется на `failed`.
Ротация секретов (`DB_URL`, `BOT_TOKEN_DEV`, `S3_KEY`) выполняется раз в неделю
скриптом `rotate_secrets.ts` (CRON `0 3 * * 0`), который после обновления
секретов выполняет `kubectl rollout restart`.

---

## 📂 Основные эндпоинты

| Метод | URL                       | Описание                      |
|-------|---------------------------|-------------------------------|
| POST  | `/v1/ai/diagnose`         | Отправка фото на диагностику |
| GET   | `/v1/photos`              | История снимков               |
| GET   | `/v1/photos/{photo_id}`   | Статус обработки фото         |
| GET   | `/v1/limits`              | Остаток бесплатных запросов  |
| GET   | `/v1/payments/{payment_id}` | Статус платежа и срок PRO    |
| POST  | `/v1/payments/sbp/webhook`| Webhook оплаты Pro            |
| POST  | `/v1/partner/orders`      | Заказ препарата от партнёра  |

OpenAPI см. в `openapi/openapi.yaml`

### Пример запроса `/v1/ai/diagnose`

API-ключ берётся из переменной окружения `API_KEY` (по умолчанию `test-api-key`).

```bash
curl -X POST http://localhost:8000/v1/ai/diagnose \
  -H "X-API-Key: $API_KEY" \
  -H "X-API-Ver: v1" \
  -H "X-User-ID: 1" \
  -H "Content-Type: application/json" \
  -d '{"image_base64":"dGVzdA==","prompt_id":"v1"}'
```

Ответ:

```json
{
  "crop": "apple",
  "disease": "powdery_mildew",
  "confidence": 0.92,
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

Перед началом убедитесь, что у вас установлен Node.js версии 18 или выше.
В репозитории есть файл `.nvmrc` с требуемой версией. При использовании `nvm`
можно выполнить `nvm use` для автоматического выбора корректной версии.

1. Скопируйте файл шаблона переменных окружения командой `cp .env.template .env` и укажите параметры подключения к БД и S3. Минимально нужны (обязательно задайте `POSTGRES_PASSWORD` в `.env`):

   ```env
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=your-postgres-password
   POSTGRES_DB=agronom
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   DATABASE_URL=postgresql://postgres:your-postgres-password@localhost:5432/agronom
   BOT_DATABASE_URL=postgresql://postgres:your-postgres-password@localhost:5432/agronom
   API_BASE_URL=http://localhost:8000

   S3_BUCKET=agronom
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minio
   S3_SECRET_KEY=minio123
   REDIS_URL=redis://localhost:6379
   RETRY_CONCURRENCY=1
   RETRY_LIMIT=3
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
API_BASE_URL=http://localhost:8000
```

Чтобы обращаться к сервисам по имени, сперва поднимите контейнеры:

```bash
docker-compose up -d
# после этого доступны DSN с именами сервисов
BOT_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/agronom
API_BASE_URL=http://api:8000
```

Если при подключении появляются ошибки DNS вроде `EAI_AGAIN`, проверьте, что
контейнеры запущены, используйте `localhost`/`127.0.0.1` для приложений вне
Docker и при необходимости очистите DNS‑кеш (`sudo systemd-resolve --flush-caches`).

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

4. Запустите API:

   ```bash
   uvicorn app.main:app --reload
   ```

5. Запустите Telegram‑бота (не забудьте указать токен и ссылку партнёра в `.env`):
   **Требуется Node.js 18+**
   В файл `.env` добавьте переменные:

   - `BOT_TOKEN_DEV=ваш_токен_бота`
   - `PARTNER_LINK_BASE=https://agrostore.ru/agronom`
   - `PAYWALL_ENABLED=true`  # включить показ paywall
   - `BOT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom`  # строка подключения для бота (в Docker: postgres)
   - `API_BASE_URL=http://localhost:8000`  # адрес API (в Docker: http://api:8000)
   - `FREE_PHOTO_LIMIT=5`  # число бесплатных фото в месяц для Telegram-бота ([пример](.env.template#L89))
   - `TINKOFF_TERMINAL_KEY=your-terminal-key`
   - `TINKOFF_SECRET_KEY=your-secret-key`
   - `HMAC_SECRET_PARTNER=test-hmac-partner`  # подпись AgroStore

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

6. Тесты запускаются командой:

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
