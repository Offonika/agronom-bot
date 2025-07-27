# Карманный агроном – Telegram Bot (MVP)

[![Python 3.12](https://img.shields.io/badge/python-3.12%2B-blue)](https://www.python.org/downloads/release/python-3120/)
> Требуется Node.js 18+ для работы Telegram-бота и тестов.

> Минималистичный AI-бот для диагностики болезней растений и рекомендаций по протоколу обработки.  
> Версия API: **v1.6.0** | Документация: в папке `docs/` | OpenAPI: `openapi/openapi.yaml`

---

## 📦 Возможности

- 📷 Приём фото листьев и анализ через GPT‑Vision
- 🧪 Возврат диагноза: `{crop, disease, confidence}`
- 📋 Протокол обработки: `{product, dosage_value, dosage_unit, phi}`
- 🕐 Ограничение FREE_MONTHLY_LIMIT фото/мес на Free-тарифе (по умолчанию 5)
- 💳 Продаёт Pro-доступ через СБП (Bot Payments 2.0)
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
- Безопасность: `X-API-Key`, `X-API-Ver`, `X-Sign`, HMAC‑SHA256

---

## 🔐 Лимиты и защита

| Тариф      | Диагнозов в месяц | Защита |
|------------|-------------------|--------|
| Free       | FREE_MONTHLY_LIMIT (по умолчанию 5) | `X-API-Key` + `X-API-Ver` |
| Pro        | ∞                 | —      |

Все эндпоинты валидируются через OpenAPI + Spectral.
Подписи от партнёров через `X-Sign` + `signature` в теле (HMAC‑SHA256).
Учёт лимита ведётся в таблице `photo_usage` (user_id, month, used). Сброс счётчиков
производит воркер `usage_reset.js` по CRON `5 0 1 * *` (МСК). При получении
ошибки 402 бот показывает paywall с предложением купить Pro.

---

## 📂 Основные эндпоинты

| Метод | URL                       | Описание                      |
|-------|---------------------------|-------------------------------|
| POST  | `/v1/ai/diagnose`         | Отправка фото на диагностику |
| GET   | `/v1/photos`              | История снимков               |
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

1. Скопируйте `.env.template` в `.env` и укажите параметры подключения к БД и S3. Минимально нужны:

   ```env
   POSTGRES_USER=postgres
   POSTGRES_PASSWORD=postgres
   POSTGRES_DB=agronom
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom
   BOT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom

   S3_BUCKET=agronom
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minio
   S3_SECRET_KEY=minio123
   ```

2. Создайте виртуальное окружение под **Python 3.12** (в нём уже есть SQLite 3.35+):

   ```bash
   python3.12 -m venv .venv
   source .venv/bin/activate
   ```

   Требуется SQLite версии **3.35+**, иначе не будут работать некоторые запросы к БД.


**Потребуется Node.js 18+** — используется для Telegram‑бота и тестов.

3. Установите зависимости командой `./.codex/setup.sh` и дополнительные пакеты для тестов из `requirements-dev.txt`. Команду `pip install -r ./requirements-dev.txt` запускайте **из корня репозитория**. Перед запуском приложения обязательно задайте `DATABASE_URL` и примените миграции:

   ```bash
   ./.codex/setup.sh
   pip install -r ./requirements-dev.txt
   export DATABASE_URL=sqlite:///./app.db  # или другая строка подключения
   alembic upgrade head
   ```
   Если пропустить этот шаг и таблица `protocols` не будет создана, функция
   `import_csv_to_db()` просто выдаст предупреждение в лог и посоветует
   выполнить `alembic upgrade head` или запустить приложение с переменной
   `DB_CREATE_ALL=1`.

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
   - `BOT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agronom`  # строка подключения для бота

  Бот подключается к PostgreSQL по DSN из `BOT_DATABASE_URL`.

   ```bash
   npm install --prefix bot
   node bot/index.js
   ```

   Базовые команды:

   - `/start` — подсказка отправить фото листа
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

7. Проверьте спецификацию OpenAPI линтером Spectral:

   ```bash
   spectral lint -r .spectral.yaml openapi/openapi.yaml
   ```


### Добавление протокола обработки

Файл `protocols.csv` лежит в корне репозитория. Формат строк:

```
crop,disease,product,dosage_value,dosage_unit,phi
apple,powdery_mildew,Скор 250 ЭК,2,ml_10l,30
```

Добавьте новую строку с культурой, болезнью и параметрами препарата.
При первом запуске приложение импортирует CSV в таблицу `protocols`.
Если таблица уже заполнена, внесите запись вручную или очистите её
перед перезапуском API.

Для загрузки CSV из открытого источника используйте скрипт:

```bash
python scripts/update_protocols.py --url <csv_url>
```

По умолчанию скачивается тестовый датасет и файл сохраняется в `protocols.csv`.

### ⚙️ Миграция на Python 3.12

1. Удалите старое окружение `.venv` (если было):

   ```bash
   rm -rf .venv
   ```

2. Пересоздайте виртуальное окружение и переустановите зависимости:

   ```bash
   python3.12 -m venv .venv
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


## License

This project is licensed under the [MIT License](LICENSE).
