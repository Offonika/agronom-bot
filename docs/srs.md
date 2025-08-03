System Requirements Specification (SRS)

Проект: Telegram‑бот «Карманный агроном» (MVP)

Версия: 1.7 — 5 августа 2025 г.(v1.6 → v1.7: выбрано SBP‑эквайринг от Тинькофф, добавлено авто‑продление Pro, уточнена политика ML‑датасета)

1 · Scope

Система «Карманный агроном»:

Принимает фотографии листьев ≤ 2 МБ (JPEG).

Отправляет JPEG в GPT‑Vision; получает диагноз {crop, disease, confidence}.

Сверяет диагноз с локальной БД протоколов Минсельхоза РФ.

Если найдено — показывает препарат, дозу, PHI + ROI‑калькулятор (экономия ₽/га).

Если не найдено — бейдж «Бета — подтвердить у агронома».

Ограничивает бесплатный тариф до 5 фото в месяц.

Продаёт подписку Pro‑Month (349 ₽/мес) и Pro‑Year (3 390 ₽/год) через Bot Payments → SBP (Тинькофф).

Подписка может быть оформлена как автоплатёж SBP (opt‑in). Бот уведомляет за 3 дня до списания. Отмена через /cancel_autopay.

При превышении лимита API возвращает 402 PAYWALL → бот показывает окно оплаты.

Ведёт историю снимков, доступную по /history.

ML‑датасет: фото старше 90 дней копируются в обезличенный бакет ml-dataset только при согласии пользователя.

Out‑of‑scope (MVP): нативные приложения, on‑device CV, карта полей, white‑label SDK.

2 · Glossary

Term

Definition

GPT‑Vision

API OpenAI для анализа изображений, возвращает JSON‑диагноз.

Protocol

Запись: crop, disease, product, dosage_value, dosage_unit, phi, registry_date.

Pro

Платный доступ без лимитов (349 ₽/мес или 3 390 ₽/год).

PHI

Pre‑Harvest Interval — срок ожидания до сбора урожая, дней.

ROI

(expected_loss₽ – cost_treatment₽) / ha.

Autopay SBP

Механизм регулярных списаний по СБП с привязкой счёта пользователя.

3 · Functional Requirements

ID

Description

Priority

FR‑T‑01

Приём изображения ≤ 2 МБ

High

FR‑T‑02

POST /v1/ai/diagnose → диагноз

High

FR‑T‑03

Отправка карточки диагноза + ROI

High

FR‑T‑04

Кнопка «Протокол» / бейдж «Бета»

High

FR‑T‑05

Paywall + покупка Pro через Bot Payments (SBP Тинькофф)

High

FR‑T‑06

Лимит 5 фото/мес для Free (GET /v1/limits)

High

FR‑T‑07

История снимков /history (cursor‑pagination)

High

FR‑T‑08

Запрос эксперту /ask_expert (SLA ≤ 2 ч)

Medium

FR‑T‑09

Webhook партнёра /v1/partner/orders

Medium

FR‑T‑10

ROI‑калькулятор: yield_loss%, price₽, cost₽

Medium

FR‑T‑11

Опция автопродления Pro (/autopay/enable, /autopay/disable)

Medium

FR‑T‑12

Экспорт / удаление данных (/v1/users/{id}/export)

Medium

4 · API Contracts

4.1 Endpoints

POST /v1/ai/diagnose

GET /v1/photos

GET /v1/limits

POST /v1/payments/sbp/webhook — Тинькофф

POST /v1/payments/sbp/autopay/webhook — Тинькофф (регулярные списания)

POST /v1/partner/orders

4.2 Schemas (excerpt)

DiagnosisResponse:
  crop: string
  disease: string
  confidence: number # 0‑1
  roi:
    economy_per_ha: number
    currency: "RUB"

PaymentWebhook:
  id: string  # invoice id
  amount: int # копейки
  status: enum {SUCCESS, FAIL, CANCEL}
  signature: string # HMAC‑SHA256

4.3 Errors

HTTP

Code

Description

400

BAD_REQUEST

Неверное изображение или тело запроса

402

PAYWALL

Требуется подписка Pro

429

LIMIT_EXCEEDED

Превышена квота

502

GPT_TIMEOUT

GPT не ответил за 10 с

5 · Data Model (PostgreSQL)

users(
  id SERIAL PRIMARY KEY,
  tg_id BIGINT UNIQUE NOT NULL,
  pro_expires_at TIMESTAMP,
  autopay_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT now()
);

photos(
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  file_id TEXT,
  crop TEXT,
  disease TEXT,
  confidence NUMERIC(4,3),
  roi NUMERIC(10,2),
  ts TIMESTAMP DEFAULT now()
);

protocols(
  id SERIAL PRIMARY KEY,
  crop TEXT,
  disease TEXT,
  product TEXT,
  dosage_value NUMERIC(6,2),
  dosage_unit TEXT,
  phi INT,
  registry_date DATE
);

payments(
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  amount INT,
  source TEXT,              -- "SBP:Tinkoff"
  autopay BOOLEAN DEFAULT FALSE,
  status TEXT,
  created_at TIMESTAMP DEFAULT now()
);

photo_usage(
  user_id INTEGER,
  month CHAR(7),            -- YYYY-MM
  used INT,
  updated_at TIMESTAMP,
  PRIMARY KEY (user_id, month)
);

Индексы: photos_user_ts_idx(user_id, ts DESC); счётчики сбрасывает CRON 5 0 1 * * (Europe/Moscow).

6 · Sequence Diagrams

6.1 Diagnose — Happy Path

User  → Bot:  фото (JPEG)
Bot   → TG:   getFile
Bot   → GPT:  diagnose
GPT   → Bot:  JSON
Bot   → DB:   INSERT photos (+ROI)
Bot   → User: диагноз + ROI + кнопка «Протокол»

6.2 Purchase Pro (one‑time)

User → Bot:  нажал «Купить Pro»
Bot  → Tinkoff:  CreateInvoice (SBP‑QR)
Bot  → User:     QR‑код
Tinkoff → Bot:   POST /payments/sbp/webhook (SUCCESS)
Bot  → DB:       UPDATE users.pro_expires_at
Bot  → User:     «Pro активирован до …»

6.3 Autopay Renewal

Cron → Bot:  проверка expiring‑soon
Bot  → User: нотификация (3 дня)
T‑0 Bot   → Tinkoff: CreateAutopayCharge
Tinkoff → Bot: POST /payments/sbp/autopay/webhook (SUCCESS|FAIL)
Bot → User:  «Продлено / Ошибка платежа»

6.4 Limit Reached

API возвращает 402 PAYWALL → бот показывает окно оплаты.

7 · Edge Cases

Code

Behavior

NO_LEAF

confidence < 0.2 → сообщение «Не удалось распознать лист…»

BLUR

variance < 50 → то же сообщение

GPT_TIMEOUT

GPT > 10 с → фото pending, уведомление пользователя

LIMIT_EXCEEDED

Free‑user > 5 фото → 402 PAYWALL

PAYMENT_FAIL

Webhook status=FAIL → grace 3 дня, повтор оплаты

8 · Non‑Functional Requirements

Metric

Target

diag_latency_p95

≤ 8 с

Availability

≥ 99.5 % / month

GPT OPEX

≤ 0.50 ₽ / фото

Expert SLA

90 % ответов ≤ 2 ч

9 · Observability

Prometheus метрики:

diag_latency_seconds

diag_requests_total

roi_calc_seconds

gpt_timeout_total

payment_fail_total

quota_reject_total

autopay_charge_seconds

Alerts:

gpt_timeout_total{5m} > 5 %

rate(error) > 2 %

queue_pending > 100

autopay_fail_total{1h} > 5

10 · Security

SBP Webhook: HMAC‑SHA256 (X-Sign + body.signature), секреты в Vault, rotation 90 дн.

GPT Key: Vault, rotation 30 дн.

Photos: S3 lifecycle delete 90 дн; при Opt‑In экспорт в ml-dataset (anonymised) на 2 года.

Соответствие ФЗ‑152/GDPR: /v1/users/{id}/export, /v1/users/{id}/delete — SLA 30 дн.

11 · DB Migration Policy

Alembic (semver). Rollback SLA 15 мин.

12 · Scalability

One worker ≈ 30 msg/s; HPA при CPU > 75 %. GPT concurrency 10/worker; Redis queue, fallback PG.

13 · Logs & Monitoring

Grafana‑Loki JSON‑логи: user_id, diag_id, latency, roi, error_code, autopay. Retention 30 дн.

14 · UX – Error Messages

Code

Message

NO_LEAF

«Не удалось распознать лист. Снимите крупнее и при дневном свете.»

LIMIT_EXCEEDED

«Лимит 5 бесплатных фото исчерпан. Pro — 349 ₽/мес без ограничений.»

GPT_TIMEOUT

«Сеть нестабильна, фото сохранено — пришлём результат позже.»

PAYMENT_FAIL

«Платёж не прошёл. Попробуйте другую карту или отмените автоплатёж.»

15 · Open Questions (закрыто в v1.7)

Вопрос

Ответ

SBP‑провайдер

Тинькофф основной, fallback — ЮKassa (Сбер)

Продление Pro

Автоплатёж SBP (opt‑in), уведомление −3 дня

ML‑датасет

Да, при Opt‑In и двойной анонимизации

16 · Approval

Role

Name

Status

CTO

—

☐

ML Lead

—

☐

FinOps

—

☐

Legal

—

☐

Документ docs/srs.md (v1.7) заменяет все предыдущие версии ≤ 1.6.