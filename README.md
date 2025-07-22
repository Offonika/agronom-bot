# Карманный агроном – Telegram Bot (MVP)

[![Python 3.12](https://img.shields.io/badge/python-3.12%2B-blue)](https://www.python.org/downloads/release/python-3120/)

> Минималистичный AI-бот для диагностики болезней растений и рекомендаций по протоколу обработки.  
> Версия API: **v1.4.0** | Документация: в папке `docs/` | OpenAPI: `openapi/openapi.yaml`

---

## 📦 Возможности

- 📷 Приём фото листьев и анализ через GPT‑Vision
- 🧪 Возврат диагноза: `{crop, disease, confidence}`
- 📋 Протокол обработки: `{product, dosage_value, dosage_unit, phi}`
- 🕐 Ограничение 5 фото/мес на Free-тарифе
- 💳 Продаёт Pro-доступ через СБП (Bot Payments 2.0)
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
| Free       | 5                 | `X-API-Key` + `X-API-Ver` |
| Pro        | ∞                 | —      |

Все эндпоинты валидируются через OpenAPI + Spectral.  
Подписи от партнёров через `X-Sign` + `signature` в теле (HMAC‑SHA256).

---

## 📂 Основные эндпоинты

| Метод | URL                       | Описание                      |
|-------|---------------------------|-------------------------------|
| POST  | `/v1/ai/diagnose`         | Отправка фото на диагностику |
| GET   | `/v1/photos`              | История снимков               |
| GET   | `/v1/limits`              | Остаток бесплатных запросов  |
| POST  | `/v1/payments/sbp/webhook`| Webhook оплаты Pro            |
| POST  | `/v1/partner/orders`      | Заказ препарата от партнёра  |

OpenAPI см. в `openapi/openapi.yaml`

### Пример запроса `/v1/ai/diagnose`

```bash
curl -X POST http://localhost:8000/v1/ai/diagnose \
  -H "X-API-Key: test-api-key" \
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
├── scripts/ # Утилиты, генераторы
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

   S3_BUCKET=agronom
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minio
   S3_SECRET_KEY=minio123
   ```

2. Создайте виртуальное окружение под **Python 3.12**:

   ```bash
   python3.12 -m venv .venv
   source .venv/bin/activate
   ```

3. Установите зависимости и примените миграции:

   ```bash
   pip install -r requirements.txt
   alembic upgrade head
   ```

4. Запустите API:

   ```bash
   uvicorn app.main:app --reload
   ```

5. Запустите Telegram‑бота (не забудьте указать токен и ссылку партнёра в `.env`):

   В файл `.env` добавьте переменные:

   - `BOT_TOKEN_DEV=ваш_токен_бота`
   - `PARTNER_LINK_BASE=https://agrostore.ru/agronom`

   ```bash
   npm install --prefix bot
   node bot/index.js
   ```

   Базовые команды:

   - `/start` — подсказка отправить фото листа
   - отправьте фото, чтобы получить диагноз и кнопку с протоколом

6. Тесты запускаются командой:

   ```bash
   pytest
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

### ⚙️ Миграция на Python 3.12

1. Удалите старое окружение `.venv` (если было):

   ```bash
   rm -rf .venv
   ```

2. Пересоздайте виртуальное окружение и переустановите зависимости:

   ```bash
   python3.12 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
📖 Документация
Смотри в папке docs/:

srs.md — системные требования

adr.md — архитектура

data_contract.md — схема БД

security_checklist.md — безопасность

partner_agrostore.md — интеграция партнёра

